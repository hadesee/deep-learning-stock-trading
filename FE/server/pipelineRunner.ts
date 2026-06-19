import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { getCandidatesPayload, refreshDashboardAiFieldsFromPipelineOutput } from "./pipelineResults";

declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

export type CandidateAnalysisRunResult = {
  dashboardUpdated: boolean;
  elapsedMs: number;
  inputJsonPath?: string;
  outputJsonPath: string;
  rows: number;
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

async function requireExistingFile(path: string, label: string): Promise<void> {
  if (!(await pathExists(path))) {
    throw new Error(`${label} not found: ${path}`);
  }
}

type PipelineInputs = {
  featureCount: string;
  indicatorPath: string;
  modelPath: string;
};

async function resolvePipelineInputs(root: string, outputDir: string, env: Record<string, string | undefined>): Promise<PipelineInputs> {
  const indicatorPath = resolve(
    env.PIPELINE_INDICATOR_PARQUET ??
      join(root, "step2_kospi200_indicators.parquet"),
  );
  const preparedIndicatorPath = resolve(join(outputDir, "step2_kospi200_indicators.parquet"));
  const v2ModelPath = resolve(join(root, "lstm_stock_model_v2.pth"));
  const tenFeatureModelPath = resolve(join(root, "lstm_stock_model_10f.pth"));
  const preparedModelPath = resolve(join(outputDir, "lstm_stock_model_top10.pth"));
  const modelPath = resolve(
    env.PIPELINE_LSTM_MODEL ??
      ((await pathExists(v2ModelPath))
        ? v2ModelPath
        : (await pathExists(tenFeatureModelPath))
          ? tenFeatureModelPath
          : preparedModelPath),
  );
  const featureCount = env.PIPELINE_FEATURE_COUNT ?? (modelPath.includes("10f") ? "10" : "11");

  if (await pathExists(indicatorPath)) {
    return { featureCount, indicatorPath, modelPath };
  }

  if (await pathExists(preparedIndicatorPath)) {
    return { featureCount, indicatorPath: preparedIndicatorPath, modelPath };
  }

  return { featureCount, indicatorPath, modelPath };
}

function pipelineInputArgs(inputs: PipelineInputs): string[] {
  return [
    "--indicator-parquet",
    inputs.indicatorPath,
    "--lstm-model",
    inputs.modelPath,
    "--feature-count",
    inputs.featureCount,
  ];
}

function tail(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(value.length - MAX_LOG_CHARS) : value;
}

function pipelineEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    APP_KEY: env.APP_KEY ?? env.KIS_APP_KEY ?? env.KIS_MOCK_APP_KEY ?? env.KIS_REAL_APP_KEY,
    APP_SECRET: env.APP_SECRET ?? env.KIS_APP_SECRET ?? env.KIS_MOCK_APP_SECRET ?? env.KIS_REAL_APP_SECRET,
  };
}

async function preparePipelineInputs(
  python: string,
  root: string,
  outputDir: string,
  inputs: PipelineInputs,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<PipelineInputs> {
  const ready = (await pathExists(inputs.indicatorPath)) && (await pathExists(inputs.modelPath));
  if (ready) {
    return inputs;
  }

  if (env.PIPELINE_BOOTSTRAP_MISSING_INPUTS === "false") {
    await requireExistingFile(inputs.indicatorPath, "Pipeline indicator parquet");
    await requireExistingFile(inputs.modelPath, "Pipeline LSTM model");
  }

  const trainScriptPath = join(root, "train_lstm_from_main_top10.py");
  await requireExistingFile(trainScriptPath, "Pipeline training script");

  const preparedInputs: PipelineInputs = {
    featureCount: env.PIPELINE_FEATURE_COUNT ?? inputs.featureCount,
    indicatorPath: resolve(join(outputDir, "step2_kospi200_indicators.parquet")),
    modelPath: resolve(join(outputDir, "lstm_stock_model_top10.pth")),
  };

  const args = [
    trainScriptPath,
    "--output-dir",
    outputDir,
    "--indicator-output",
    preparedInputs.indicatorPath,
    "--model-output",
    preparedInputs.modelPath,
    "--feature-count",
    preparedInputs.featureCount,
  ];

  optionalNumericArg(args, "--top", env.PIPELINE_PREPARE_TOP ?? env.PIPELINE_RUN_TOP);
  optionalNumericArg(args, "--years", env.PIPELINE_PREPARE_YEARS);
  optionalNumericArg(args, "--epochs", env.PIPELINE_PREPARE_EPOCHS);
  optionalNumericArg(args, "--sequence-length", env.PIPELINE_PREPARE_SEQUENCE_LENGTH);
  optionalNumericArg(args, "--batch-size", env.PIPELINE_PREPARE_BATCH_SIZE);

  await runProcess(python, args, root, pipelineEnv(env), timeoutMs);
  await requireExistingFile(preparedInputs.indicatorPath, "Prepared indicator parquet");
  await requireExistingFile(preparedInputs.modelPath, "Prepared LSTM model");

  return preparedInputs;
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

async function executeCandidateAnalysis(env = process.env): Promise<CandidateAnalysisRunResult> {
  const startedAt = Date.now();
  const root = projectRoot(env);
  const scriptPath = join(root, "integrated_pipeline.py");
  const outputDir = resolve(env.PIPELINE_OUTPUT_DIR ?? join(root, "outputs"));
  const outputJsonPath = join(outputDir, "final_stock_lstm_news_llm_result.json");
  const timeoutMs = Number(env.PIPELINE_RUN_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const python = await pythonExecutable(root, env);

  if (!(await pathExists(scriptPath))) {
    throw new Error(`Pipeline script not found: ${scriptPath}`);
  }

  const inputs = await preparePipelineInputs(
    python,
    root,
    outputDir,
    await resolvePipelineInputs(root, outputDir, env),
    env,
    timeoutMs,
  );
  const args = [scriptPath, "--output-dir", outputDir, ...pipelineInputArgs(inputs)];
  const selectedStocksPath = join(outputDir, "selected_top_stocks.csv");
  if (await pathExists(selectedStocksPath)) {
    args.push("--selected-stocks-csv", selectedStocksPath);
  }
  optionalNumericArg(args, "--top", env.PIPELINE_RUN_TOP);
  optionalNumericArg(args, "--news-days", env.PIPELINE_RUN_NEWS_DAYS);
  optionalNumericArg(args, "--max-news", env.PIPELINE_RUN_MAX_NEWS);
  if (env.PIPELINE_OPENAI_MODEL) {
    args.push("--openai-model", env.PIPELINE_OPENAI_MODEL);
  }

  await runProcess(python, args, root, pipelineEnv(env), timeoutMs);

  const rows = await getCandidatesPayload();
  if (rows.length === 0) {
    throw new Error(`Pipeline finished, but no candidate rows were written to ${outputJsonPath}.`);
  }

  return {
    dashboardUpdated: await refreshDashboardAiFieldsFromPipelineOutput(),
    elapsedMs: Date.now() - startedAt,
    inputJsonPath: inputs.indicatorPath,
    outputJsonPath,
    rows: rows.length,
    status: "completed",
  };
}

export async function runCandidateAnalysis(env = process.env): Promise<CandidateAnalysisRunResult> {
  if (!activeRun) {
    activeRun = executeCandidateAnalysis(env).finally(() => {
      activeRun = null;
    });
  }

  return activeRun;
}
