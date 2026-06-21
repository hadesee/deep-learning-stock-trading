import { spawn } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipelineOutputDir, pipelineProjectRoot, writePipelineRunMarker } from "./pipelineFreshness";
import { getCandidatesPayload, refreshDashboardAiFieldsFromPipelineOutput } from "./pipelineResults";

declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

export type CandidateAnalysisRunResult = {
  dashboardUpdated: boolean;
  elapsedMs: number;
  rows: number;
  /** Number of stocks the Gemini news step analyzed; 0 when the step was skipped or failed. */
  newsRows: number;
  status: "completed";
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_LOG_CHARS = 6000;

export type CandidateAnalysisProgress = {
  stage: string;
  stageCount: number;
  stageIndex: number;
  progressPercent: number;
  message: string;
  updatedAt: number;
};

const CANDIDATE_PROGRESS_STAGES = [
  "실행 준비",
  "KOSPI200 후보 풀 로드",
  "OHLCV 수집·Transformer 예측",
  "외국인·기관 수급 조회",
  "뉴스 크롤링",
  "Gemini LLM 종합 판단",
  "결과 파일 검증",
] as const;

let activeRun: Promise<CandidateAnalysisRunResult> | null = null;

function boundedPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function cleanLogLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function publicCandidateAnalysisError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout|시간이 초과/i.test(message)) {
    return "AI 후보 분석 시간이 초과되었습니다. 잠시 후 다시 실행하거나 서버 콘솔에서 병목 단계를 확인하세요.";
  }
  if (/not found|없음|not updated|찾지 못|결과 파일/i.test(message)) {
    return "분석 결과 파일을 확인하지 못했습니다. 서버 콘솔에서 파이프라인 실행 상태를 확인하세요.";
  }
  return "AI 후보 분석 중 오류가 발생했습니다. 서버 콘솔에서 상세 로그를 확인하세요.";
}

function progressSnapshot(
  stageIndex: number,
  progressPercent: number,
  message?: string,
  previous?: CandidateAnalysisProgress,
): CandidateAnalysisProgress {
  const safeStageIndex = Math.min(Math.max(stageIndex, 0), CANDIDATE_PROGRESS_STAGES.length - 1);
  return {
    message: message ?? CANDIDATE_PROGRESS_STAGES[safeStageIndex],
    progressPercent: boundedPercent(progressPercent),
    stage: CANDIDATE_PROGRESS_STAGES[safeStageIndex],
    stageCount: CANDIDATE_PROGRESS_STAGES.length,
    stageIndex: safeStageIndex,
    updatedAt: Date.now(),
  };
}

function initialProgress(): CandidateAnalysisProgress {
  return progressSnapshot(0, 3, "분석 작업을 준비하는 중입니다.");
}

function nextProgressFromLog(line: string, current: CandidateAnalysisProgress): CandidateAnalysisProgress {
  const log = cleanLogLine(line);
  let stageIndex = current.stageIndex;
  let progressPercent = current.progressPercent;
  let message = current.message;

  const advance = (nextStage: number, nextPercent: number, nextMessage: string) => {
    stageIndex = Math.max(stageIndex, nextStage);
    progressPercent = Math.max(progressPercent, nextPercent);
    message = nextMessage;
  };

  if (log.includes("[STEP 1]")) {
    advance(1, 12, "KOSPI200 후보 풀을 불러오는 중입니다.");
  } else if (log.includes("로드 완료")) {
    advance(1, 20, "KOSPI200 후보 풀 로드가 완료되었습니다.");
  } else if (log.includes("[STEP 2]")) {
    advance(2, 26, "OHLCV를 수집하고 Transformer 상승 확률을 계산하는 중입니다.");
  } else if (log.includes("[OHLCV 조회]")) {
    const ohlcvMatch = log.match(/OHLCV 조회\]\s*([0-9]+)\/([0-9]+)/);
    if (ohlcvMatch) {
      const current = Number(ohlcvMatch[1]);
      const total = Math.max(1, Number(ohlcvMatch[2]));
      const ohlcvProgress = 26 + Math.min(18, Math.round((current / total) * 18));
      advance(2, ohlcvProgress, `KOSPI200 OHLCV를 수집하는 중입니다. (${current}/${total})`);
    }
  } else if (log.includes("[Transformer 예측]")) {
    advance(2, 46, "Transformer 배치 추론을 실행하는 중입니다.");
  } else if (log.includes("P(up) 예측 성공")) {
    const countMatch = log.match(/P\(up\) 예측 성공:\s*([0-9]+)\/([0-9]+)개/);
    advance(
      2,
      50,
      countMatch
        ? `Transformer 예측 완료: ${countMatch[1]}/${countMatch[2]}개 종목`
        : "Transformer 예측이 완료되었습니다.",
    );
  } else if (log.includes("[수급 조회]")) {
    const supplyMatch = log.match(/수급 조회\]\s*([0-9]+)\/([0-9]+)/);
    if (supplyMatch) {
      const current = Number(supplyMatch[1]);
      const total = Math.max(1, Number(supplyMatch[2]));
      const supplyProgress = 60 + Math.min(8, Math.round((current / total) * 8));
      advance(3, supplyProgress, `상위 후보의 외국인·기관 수급을 확인하는 중입니다. (${current}/${total})`);
    }
  } else if (log.includes("Transformer 최종")) {
    advance(3, 68, "수급 확인을 반영해 최종 후보를 구성하는 중입니다.");
  } else if (log.includes("[STEP 3]")) {
    advance(4, 72, "STEP2 Top10을 기반으로 뉴스·LLM 분석을 시작합니다.");
  } else if (log.includes("뉴스 크롤링")) {
    advance(4, 78, "최신 뉴스를 수집하는 중입니다.");
  } else if (log.includes("Gemini") || log.includes("LLM") || log.includes("API 호출")) {
    advance(5, 84, "Gemini가 모델·수급·뉴스 근거를 종합 판단하는 중입니다.");
  } else if (log.includes("[최종 결과]")) {
    advance(5, 90, "종목별 LLM 판단 결과를 정리하는 중입니다.");
  } else if (log.includes("저장:") && log.includes("step3")) {
    advance(6, 94, "STEP3 결과 파일을 저장하고 검증하는 중입니다.");
  } else if (log.includes("[ALL DONE]")) {
    advance(6, 100, "전체 파이프라인이 완료되었습니다.");
  }

  return {
    ...progressSnapshot(stageIndex, progressPercent, message, current),
  };
}

function updateCandidateAnalysisProgress(
  updater: CandidateAnalysisProgress | ((current: CandidateAnalysisProgress) => CandidateAnalysisProgress),
): void {
  if (runState.status !== "running") {
    return;
  }

  const next = typeof updater === "function" ? updater(runState.progress) : updater;
  runState = { ...runState, progress: next };
}

function recordCandidateAnalysisOutput(text: string): void {
  const lines = text.split(/\r?\n/).map(cleanLogLine).filter(Boolean);
  for (const line of lines) {
    updateCandidateAnalysisProgress((current) => nextProgressFromLog(line, current));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function projectRoot(env: Record<string, string | undefined>): string {
  return pipelineProjectRoot(env);
}

async function pythonExecutable(root: string, env: Record<string, string | undefined>): Promise<string> {
  if (env.PYTHON_EXECUTABLE) {
    return env.PYTHON_EXECUTABLE;
  }

  const candidates = [
    join(root, "venv", "Scripts", "python.exe"),
    join(root, ".venv", "Scripts", "python.exe"),
    "py",
    "python",
  ];

  for (const candidate of candidates.slice(0, -1)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1];
}

function optionalNumericArg(args: string[], name: string, value: string | undefined): void {
  if (!value) {
    return;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    args.push(name, String(Math.floor(parsed)));
  }
}

async function requireExistingFile(path: string, label: string): Promise<void> {
  if (!(await pathExists(path))) {
    throw new Error(`${label} not found: ${path}`);
  }
}

async function requireFreshFile(path: string, label: string, startedAt: number): Promise<void> {
  await requireExistingFile(path, label);

  const file = await stat(path);
  if (file.mtimeMs + 1000 < startedAt) {
    throw new Error(`${label} was not updated by the latest pipeline run: ${path}`);
  }
}

type PipelineInputs = {
  mainModulePath: string;
  predictModulePath: string;
  transformerCkptPath: string;
};

function resolvePipelineInputs(root: string, env: Record<string, string | undefined>): PipelineInputs {
  return {
    mainModulePath: resolve(env.PIPELINE_MAIN_MODULE ?? join(root, "main.py")),
    predictModulePath: resolve(env.PIPELINE_PREDICT_MODULE ?? join(root, "predict.py")),
    transformerCkptPath: resolve(env.PIPELINE_TRANSFORMER_CKPT ?? join(root, "transformer_5y.pt")),
  };
}

function pipelineInputArgs(inputs: PipelineInputs): string[] {
  return [
    "--main-module",
    inputs.mainModulePath,
    "--transformer-ckpt",
    inputs.transformerCkptPath,
    "--predict-module",
    inputs.predictModulePath,
  ];
}

function tail(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(value.length - MAX_LOG_CHARS) : value;
}

function pipelineEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = {
    ...env,
    PYTHONIOENCODING: env.PYTHONIOENCODING ?? "utf-8",
    PYTHONUTF8: env.PYTHONUTF8 ?? "1",
    // Unbuffered stdout/stderr so per-stock progress streams live to the dev
    // console instead of arriving in one big buffered chunk at the end.
    PYTHONUNBUFFERED: env.PYTHONUNBUFFERED ?? "1",
  };
  const kisEnv = env.KIS_ENV === "real" ? "real" : "mock";
  const appKey =
    kisEnv === "real"
      ? env.KIS_REAL_APP_KEY ?? env.KIS_APP_KEY ?? env.APP_KEY
      : env.KIS_MOCK_APP_KEY ?? env.KIS_APP_KEY ?? env.APP_KEY;
  const appSecret =
    kisEnv === "real"
      ? env.KIS_REAL_APP_SECRET ?? env.KIS_APP_SECRET ?? env.APP_SECRET
      : env.KIS_MOCK_APP_SECRET ?? env.KIS_APP_SECRET ?? env.APP_SECRET;
  const openAiKey = env.OPENAI_API_KEY ?? env.OPEN_AI_KEY ?? env.OPEN_AI;

  if (appKey) {
    next.APP_KEY = appKey;
  }
  if (appSecret) {
    next.APP_SECRET = appSecret;
  }
  if (openAiKey) {
    next.OPENAI_API_KEY = openAiKey;
  }

  return next;
}

async function preparePipelineInputs(inputs: PipelineInputs): Promise<PipelineInputs> {
  await requireExistingFile(inputs.mainModulePath, "Pipeline main module");
  await requireExistingFile(inputs.predictModulePath, "Pipeline predict module");
  await requireExistingFile(inputs.transformerCkptPath, "Pipeline Transformer checkpoint");
  return inputs;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  onOutput?: (text: string) => void,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = globalThis.setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
        settled = true;
        rejectRun(new Error(`AI candidate analysis timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = tail(stdout + text);
      onOutput?.(text);
      // Stream progress to the dev console so a long run isn't a silent black box.
      const trimmed = text.replace(/\s+$/, "");
      if (trimmed) {
        console.log(`[pipeline] ${trimmed}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = tail(stderr + text);
      onOutput?.(text);
      const trimmed = text.replace(/\s+$/, "");
      if (trimmed) {
        console.error(`[pipeline] ${trimmed}`);
      }
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      rejectRun(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);

      if (code === 0) {
        resolveRun();
        return;
      }

      const log = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
      rejectRun(new Error(log || `AI candidate analysis exited with code ${code ?? "unknown"}.`));
    });
  });
}

/** File the on-demand per-stock Gemini news step writes and {@link pipelineResults} overlays. */
const NEWS_RESULT_FILE = "news_gemini_result.json";

async function countJsonObjectRows(newsOutputPath: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(newsOutputPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? Object.keys(parsed as Record<string, unknown>).length : 0;
  } catch {
    return 0;
  }
}

async function executeCandidateAnalysis(env = process.env): Promise<CandidateAnalysisRunResult> {
  const startedAt = Date.now();
  const root = projectRoot(env);
  const scriptPath = join(root, "integrated_pipeline.py");
  const outputDir = pipelineOutputDir(env);
  const top10CsvPath = join(outputDir, "step2_final_top10.csv");
  const step3CsvPath = join(outputDir, "step3_final_news_llm_analysis.csv");
  const step3JsonPath = join(outputDir, "step3_final_news_llm_analysis.json");
  const timeoutMs = Number(env.PIPELINE_RUN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const python = await pythonExecutable(root, env);

  updateCandidateAnalysisProgress(progressSnapshot(0, 5, "파이프라인 파일과 실행 환경을 확인하는 중입니다."));
  await requireExistingFile(scriptPath, "Pipeline script");
  await mkdir(outputDir, { recursive: true });
  await writePipelineRunMarker({ startedAt, status: "running" }, env);

  try {
    const inputs = await preparePipelineInputs(resolvePipelineInputs(root, env));
    const args = [scriptPath, "--output-dir", outputDir, ...pipelineInputArgs(inputs)];

    optionalNumericArg(args, "--candidate-pool", env.PIPELINE_CANDIDATE_POOL);
    optionalNumericArg(args, "--final-max", env.PIPELINE_FINAL_MAX ?? env.PIPELINE_RUN_TOP);
    optionalNumericArg(args, "--ohlcv-lookback-days", env.PIPELINE_OHLCV_LOOKBACK_DAYS);
    optionalNumericArg(args, "--supply-window", env.PIPELINE_SUPPLY_WINDOW);
    optionalNumericArg(args, "--supply-min-positive-days", env.PIPELINE_SUPPLY_MIN_POSITIVE_DAYS);

    updateCandidateAnalysisProgress(progressSnapshot(0, 8, "integrated_pipeline.py 실행을 시작했습니다."));
    await runProcess(python, args, root, pipelineEnv(env), timeoutMs, recordCandidateAnalysisOutput);

    updateCandidateAnalysisProgress((current) => progressSnapshot(6, 95, "생성된 step2·step3 결과 파일을 검증하는 중입니다.", current));
    await requireFreshFile(top10CsvPath, "Transformer Top10 CSV", startedAt);
    await requireFreshFile(step3CsvPath, "STEP3 LLM CSV result", startedAt);
    await requireFreshFile(step3JsonPath, "STEP3 LLM JSON result", startedAt);
    await writePipelineRunMarker({
      finishedAt: Date.now(),
      startedAt,
      status: "completed",
    }, env);

    updateCandidateAnalysisProgress((current) => progressSnapshot(6, 98, "분석 결과를 대시보드 데이터로 변환하는 중입니다.", current));
    const rows = await getCandidatesPayload();
    const result = {
      dashboardUpdated: await refreshDashboardAiFieldsFromPipelineOutput(),
      elapsedMs: Date.now() - startedAt,
      rows: rows.length,
      newsRows: await countJsonObjectRows(step3JsonPath),
      status: "completed" as const,
    };
    await writePipelineRunMarker({
      finishedAt: Date.now(),
      newsRows: result.newsRows,
      rows: result.rows,
      startedAt,
      status: "completed",
    }, env);

    return result;
  } catch (error) {
    await writePipelineRunMarker({
      error: publicCandidateAnalysisError(error),
      finishedAt: Date.now(),
      startedAt,
      status: "failed",
    }, env);
    throw error;
  }
}

/**
 * Status snapshot returned by `GET /api/candidates/run`. The run is async: a
 * single HTTP request can't survive the analysis (it takes minutes, and a
 * Cloudflare Tunnel cuts the origin off at ~100s with a 524). So POST starts the
 * job in the background and clients poll this status until it settles.
 */
export type CandidateAnalysisStatus = {
  status: "idle" | "running" | "completed" | "failed";
  startedAt?: number;
  finishedAt?: number;
  elapsedMs?: number;
  progress?: CandidateAnalysisProgress;
  result?: CandidateAnalysisRunResult;
  error?: string;
};

type RunState =
  | { status: "idle" }
  | { status: "running"; startedAt: number; progress: CandidateAnalysisProgress }
  | { status: "completed"; startedAt: number; finishedAt: number; progress: CandidateAnalysisProgress; result: CandidateAnalysisRunResult }
  | { status: "failed"; startedAt: number; finishedAt: number; progress: CandidateAnalysisProgress; error: string };

let runState: RunState = { status: "idle" };

function candidateProgressStaleMs(): number {
  const parsed = Number(process.env.PIPELINE_PROGRESS_STALE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

function failStaleCandidateRunIfNeeded(): void {
  if (runState.status !== "running") {
    return;
  }

  const staleMs = candidateProgressStaleMs();
  if (Date.now() - runState.progress.updatedAt < staleMs) {
    return;
  }

  const failedAt = Date.now();
  const startedAt = runState.startedAt;
  const error = "AI 후보 분석 진행 로그가 오래 갱신되지 않았습니다. 파이프라인 상태를 확인한 뒤 다시 실행하세요.";
  runState = {
    error,
    finishedAt: failedAt,
    progress: progressSnapshot(
      runState.progress.stageIndex,
      runState.progress.progressPercent,
      "분석 진행이 오래 갱신되지 않았습니다.",
      runState.progress,
    ),
    startedAt,
    status: "failed",
  };
  void writePipelineRunMarker({ error, finishedAt: failedAt, startedAt, status: "failed" }).catch(() => {});
}

export function getCandidateAnalysisStatus(): CandidateAnalysisStatus {
  failStaleCandidateRunIfNeeded();

  switch (runState.status) {
    case "running":
      return {
        status: "running",
        startedAt: runState.startedAt,
        elapsedMs: Date.now() - runState.startedAt,
        progress: runState.progress,
      };
    case "completed":
      return {
        status: "completed",
        startedAt: runState.startedAt,
        finishedAt: runState.finishedAt,
        elapsedMs: runState.finishedAt - runState.startedAt,
        progress: runState.progress,
        result: runState.result,
      };
    case "failed":
      return {
        status: "failed",
        startedAt: runState.startedAt,
        finishedAt: runState.finishedAt,
        elapsedMs: runState.finishedAt - runState.startedAt,
        progress: runState.progress,
        error: runState.error,
      };
    default:
      return { status: "idle" };
  }
}

/**
 * Starts the analysis in the background (or attaches to the in-flight run) and
 * returns the current status immediately, so the HTTP request never blocks long
 * enough to hit the tunnel's gateway timeout. Poll {@link getCandidateAnalysisStatus}.
 */
export function startCandidateAnalysis(env = process.env): CandidateAnalysisStatus {
  if (!activeRun) {
    const startedAt = Date.now();
    runState = { status: "running", startedAt, progress: initialProgress() };

    activeRun = executeCandidateAnalysis(env);
    activeRun
      .then((result) => {
        const progress =
          runState.status === "running"
            ? progressSnapshot(6, 100, "분석이 완료되었습니다.", runState.progress)
            : progressSnapshot(6, 100, "분석이 완료되었습니다.");
        runState = { status: "completed", startedAt, finishedAt: Date.now(), progress, result };
      })
      .catch((error: unknown) => {
        const privateMessage = error instanceof Error ? error.message : String(error);
        const publicMessage = publicCandidateAnalysisError(error);
        console.error(`[pipeline] Candidate analysis failed: ${privateMessage}`);
        const progress =
          runState.status === "running"
            ? progressSnapshot(runState.progress.stageIndex, runState.progress.progressPercent, "분석 중 오류가 발생했습니다.", runState.progress)
            : progressSnapshot(0, 0, "분석 중 오류가 발생했습니다.");
        runState = {
          status: "failed",
          startedAt,
          finishedAt: Date.now(),
          progress,
          error: publicMessage,
        };
      })
      .finally(() => {
        activeRun = null;
      });
  }

  return getCandidateAnalysisStatus();
}

/**
 * Backwards-compatible blocking variant: starts the run if needed and awaits it.
 * Prefer {@link startCandidateAnalysis} + polling for anything fronted by a proxy
 * or tunnel that enforces a request timeout.
 */
export async function runCandidateAnalysis(env = process.env): Promise<CandidateAnalysisRunResult> {
  if (!activeRun) {
    activeRun = executeCandidateAnalysis(env).finally(() => {
      activeRun = null;
    });
  }

  return activeRun;
}

export type StockNewsAnalysisResult = {
  elapsedMs: number;
  status: "completed";
  ticker: string;
};

export type StockNewsAnalysisStatus = {
  status: "idle" | "running" | "completed" | "failed";
  ticker: string;
  startedAt?: number;
  finishedAt?: number;
  elapsedMs?: number;
  result?: StockNewsAnalysisResult;
  error?: string;
};

type StockNewsRunState =
  | { status: "running"; ticker: string; startedAt: number }
  | { status: "completed"; ticker: string; startedAt: number; finishedAt: number; result: StockNewsAnalysisResult }
  | { status: "failed"; ticker: string; startedAt: number; finishedAt: number; error: string };

const stockNewsRuns = new Map<string, Promise<StockNewsAnalysisResult>>();
const stockNewsStates = new Map<string, StockNewsRunState>();

function normalizedTicker(value: string): string {
  const ticker = String(value ?? "").replace(/\D/g, "").padStart(6, "0").slice(-6);
  if (!/^\d{6}$/.test(ticker) || ticker === "000000") {
    throw new Error("A valid 6-digit ticker is required.");
  }
  return ticker;
}

async function executeStockNewsAnalysis(
  ticker: string,
  env: Record<string, string | undefined>,
): Promise<StockNewsAnalysisResult> {
  const startedAt = Date.now();
  const root = projectRoot(env);
  const outputDir = resolve(env.PIPELINE_OUTPUT_DIR ?? join(root, "outputs"));
  const scriptPath = resolve(env.PIPELINE_NEWS_SCRIPT ?? join(root, "crolling.py"));
  const inputPath = join(outputDir, "step2_all_transformer_rank.csv");
  const outputPath = join(outputDir, NEWS_RESULT_FILE);
  const python = await pythonExecutable(root, env);
  const timeoutMs = Number(env.PIPELINE_RUN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  await requireExistingFile(scriptPath, "News analysis script");
  await requireExistingFile(inputPath, "Full Transformer ranking");

  const args = [
    scriptPath,
    "--input",
    inputPath,
    "--ticker",
    ticker,
    "--output",
    outputPath,
    "--merge",
  ];
  optionalNumericArg(args, "--days", env.PIPELINE_RUN_NEWS_DAYS);
  optionalNumericArg(args, "--max-news", env.PIPELINE_RUN_MAX_NEWS);

  await runProcess(python, args, root, pipelineEnv(env), timeoutMs);

  const parsed = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
  if (!parsed[ticker]) {
    throw new Error(`Gemini analysis did not return a result for ${ticker}.`);
  }

  return { elapsedMs: Date.now() - startedAt, status: "completed", ticker };
}

export function getStockNewsAnalysisStatus(tickerValue: string): StockNewsAnalysisStatus {
  const ticker = normalizedTicker(tickerValue);
  const state = stockNewsStates.get(ticker);
  if (!state) {
    return { status: "idle", ticker };
  }
  if (state.status === "running") {
    return { ...state, elapsedMs: Date.now() - state.startedAt };
  }
  return {
    ...state,
    elapsedMs: state.finishedAt - state.startedAt,
  };
}

export function startStockNewsAnalysis(
  tickerValue: string,
  env = process.env,
): StockNewsAnalysisStatus {
  const ticker = normalizedTicker(tickerValue);
  if (!stockNewsRuns.has(ticker)) {
    const startedAt = Date.now();
    stockNewsStates.set(ticker, { status: "running", ticker, startedAt });
    const run = executeStockNewsAnalysis(ticker, env);
    stockNewsRuns.set(ticker, run);
    run
      .then((result) => {
        stockNewsStates.set(ticker, { status: "completed", ticker, startedAt, finishedAt: Date.now(), result });
      })
      .catch((error: unknown) => {
        stockNewsStates.set(ticker, {
          status: "failed",
          ticker,
          startedAt,
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        stockNewsRuns.delete(ticker);
      });
  }
  return getStockNewsAnalysisStatus(ticker);
}
