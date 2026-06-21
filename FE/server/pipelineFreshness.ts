import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

export type PipelineRunMarker = {
  status: "running" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  newsRows?: number;
  rows?: number;
};

export function pipelineProjectRoot(env = process.env): string {
  return resolve(env.PIPELINE_PROJECT_ROOT ?? join(process.cwd(), ".."));
}

export function pipelineOutputDir(env = process.env): string {
  return resolve(env.PIPELINE_OUTPUT_DIR ?? join(pipelineProjectRoot(env), "outputs"));
}

export function pipelineRunMarkerPath(env = process.env): string {
  return join(pipelineOutputDir(env), ".candidate-analysis-run.json");
}

export async function readPipelineRunMarker(env = process.env): Promise<PipelineRunMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(pipelineRunMarkerPath(env), "utf8")) as Partial<PipelineRunMarker>;
    if (
      parsed &&
      (parsed.status === "running" || parsed.status === "completed" || parsed.status === "failed") &&
      typeof parsed.startedAt === "number"
    ) {
      return parsed as PipelineRunMarker;
    }
  } catch {
    return null;
  }

  return null;
}

export async function writePipelineRunMarker(marker: PipelineRunMarker, env = process.env): Promise<void> {
  const path = pipelineRunMarkerPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(marker), "utf8");
}

export function isFreshForRun(mtimeMs: number, marker: PipelineRunMarker | null): boolean {
  if (!marker) {
    return true;
  }

  return marker.status === "completed" && mtimeMs + 1000 >= marker.startedAt;
}
