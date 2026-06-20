import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getCandidatesPayload, refreshDashboardAiFieldsFromPipelineOutput } from "./pipelineResults";

declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

export type CandidateAnalysisRunResult = {
  dashboardUpdated: boolean;
  elapsedMs: number;
  outputCsvPath?: string;
  outputJsonPath: string;
  rows: number;
  /** Number of stocks the Gemini news step analyzed; 0 when the step was skipped or failed. */
  newsRows: number;
  status: "completed";
};

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_LOG_CHARS = 6000;

let activeRun: Promise<CandidateAnalysisRunResult> | null = null;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function projectRoot(env: Record<string, string | undefined>): string {
  return resolve(env.PIPELINE_PROJECT_ROOT ?? join(process.cwd(), ".."));
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

function truthyEnv(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

async function requireExistingFile(path: string, label: string): Promise<void> {
  if (!(await pathExists(path))) {
    throw new Error(`${label} not found: ${path}`);
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
  };
  const appKey = env.KIS_MOCK_APP_KEY ?? env.KIS_APP_KEY ?? env.APP_KEY ?? env.KIS_REAL_APP_KEY;
  const appSecret = env.KIS_MOCK_APP_SECRET ?? env.KIS_APP_SECRET ?? env.APP_SECRET ?? env.KIS_REAL_APP_SECRET;
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
      stdout = tail(stdout + chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      stderr = tail(stderr + chunk.toString());
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

/** File the Gemini news step writes and {@link pipelineResults} overlays. */
const NEWS_RESULT_FILE = "news_gemini_result.json";

/**
 * Whether to run the Gemini news step. Defaults to on so the combined analysis
 * surfaces news sentiment; set `PIPELINE_RUN_NEWS=false` to skip (e.g. no Gemini
 * key, or to save API cost). Credentials live in the project-root `.env` that
 * crolling.py loads itself, so we don't gate on Node seeing the keys.
 */
function shouldRunNews(env: Record<string, string | undefined>): boolean {
  const explicit = (env.PIPELINE_RUN_NEWS ?? "").trim();
  if (explicit !== "") {
    return truthyEnv(explicit);
  }
  return true;
}

/**
 * Spawns crolling.py with the Transformer Top-N CSV as input, writing
 * `outputs/news_gemini_result.json`. Returns the analyzed-stock count, or 0 when
 * skipped/failed (best-effort — never throws).
 */
async function runNewsStep(
  python: string,
  root: string,
  outputDir: string,
  inputCsvPath: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<number> {
  if (!shouldRunNews(env)) {
    return 0;
  }

  const newsScript = resolve(env.PIPELINE_NEWS_SCRIPT ?? join(root, "crolling.py"));
  if (!(await pathExists(newsScript))) {
    return 0;
  }

  const newsOutputPath = join(outputDir, NEWS_RESULT_FILE);
  const args = [newsScript, "--input", inputCsvPath, "--output", newsOutputPath];
  optionalNumericArg(args, "--days", env.PIPELINE_RUN_NEWS_DAYS);
  optionalNumericArg(args, "--max-news", env.PIPELINE_RUN_MAX_NEWS);

  try {
    await runProcess(python, args, root, pipelineEnv(env), timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[pipeline] News step (crolling.py) failed; candidates returned without news: ${message}`);
    return 0;
  }

  return countNewsRows(newsOutputPath);
}

async function countNewsRows(newsOutputPath: string): Promise<number> {
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
  const outputDir = resolve(env.PIPELINE_OUTPUT_DIR ?? join(root, "outputs"));
  const outputCsvPath = join(outputDir, "step2_final_top10.csv");
  const outputJsonPath = join(outputDir, "final_stock_transformer_news_llm_result.json");
  const timeoutMs = Number(env.PIPELINE_RUN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const python = await pythonExecutable(root, env);

  await requireExistingFile(scriptPath, "Pipeline script");
  await mkdir(outputDir, { recursive: true });

  const inputs = await preparePipelineInputs(resolvePipelineInputs(root, env));
  const args = [scriptPath, "--output-dir", outputDir, ...pipelineInputArgs(inputs)];

  optionalNumericArg(args, "--candidate-pool", env.PIPELINE_CANDIDATE_POOL);
  optionalNumericArg(args, "--final-max", env.PIPELINE_FINAL_MAX ?? env.PIPELINE_RUN_TOP);
  optionalNumericArg(args, "--ohlcv-lookback-days", env.PIPELINE_OHLCV_LOOKBACK_DAYS);
  optionalNumericArg(args, "--supply-window", env.PIPELINE_SUPPLY_WINDOW);
  optionalNumericArg(args, "--supply-min-positive-days", env.PIPELINE_SUPPLY_MIN_POSITIVE_DAYS);

  await runProcess(python, args, root, pipelineEnv(env), timeoutMs);

  // News + Gemini sentiment is a separate best-effort step (crolling.py) that
  // overlays onto the Transformer candidates. A failure here (missing key, news
  // outage) must not discard the candidate output, so it's caught and logged.
  const newsRows = await runNewsStep(python, root, outputDir, outputCsvPath, env, timeoutMs);

  const rows = await getCandidatesPayload();
  if (rows.length === 0) {
    throw new Error(`Pipeline finished, but no candidate rows were found in ${outputJsonPath} or ${outputCsvPath}.`);
  }

  return {
    dashboardUpdated: await refreshDashboardAiFieldsFromPipelineOutput(),
    elapsedMs: Date.now() - startedAt,
    outputCsvPath,
    outputJsonPath: outputCsvPath,
    rows: rows.length,
    newsRows,
    status: "completed",
  };
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
  result?: CandidateAnalysisRunResult;
  error?: string;
};

type RunState =
  | { status: "idle" }
  | { status: "running"; startedAt: number }
  | { status: "completed"; startedAt: number; finishedAt: number; result: CandidateAnalysisRunResult }
  | { status: "failed"; startedAt: number; finishedAt: number; error: string };

let runState: RunState = { status: "idle" };

export function getCandidateAnalysisStatus(): CandidateAnalysisStatus {
  switch (runState.status) {
    case "running":
      return { status: "running", startedAt: runState.startedAt, elapsedMs: Date.now() - runState.startedAt };
    case "completed":
      return {
        status: "completed",
        startedAt: runState.startedAt,
        finishedAt: runState.finishedAt,
        elapsedMs: runState.finishedAt - runState.startedAt,
        result: runState.result,
      };
    case "failed":
      return {
        status: "failed",
        startedAt: runState.startedAt,
        finishedAt: runState.finishedAt,
        elapsedMs: runState.finishedAt - runState.startedAt,
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
    runState = { status: "running", startedAt };

    activeRun = executeCandidateAnalysis(env);
    activeRun
      .then((result) => {
        runState = { status: "completed", startedAt, finishedAt: Date.now(), result };
      })
      .catch((error: unknown) => {
        runState = {
          status: "failed",
          startedAt,
          finishedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
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
