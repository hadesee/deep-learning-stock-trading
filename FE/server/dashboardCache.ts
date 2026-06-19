import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MarketDashboardData } from "../src/types/trading";

declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

type CachedSnapshot = {
  builtAt: number;
  data: MarketDashboardData;
};

/** In-process copy so warm serverless invocations skip the disk read entirely. */
let memorySnapshot: CachedSnapshot | null = null;

function snapshotPath(): string {
  return process.env.DASHBOARD_SNAPSHOT_PATH ?? join(process.cwd(), "server", "cache", "dashboard-snapshot.json");
}

/**
 * Default freshness window. A pre-warmed snapshot (the batch job) lets the
 * request handler serve the full KOSPI200 list instantly instead of making
 * ~200 rate-limited KIS calls inline. Tune via `DASHBOARD_SNAPSHOT_TTL_MS`.
 */
function ttlMs(): number {
  const parsed = Number(process.env.DASHBOARD_SNAPSHOT_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 60 * 1000;
}

export async function readDashboardSnapshot(maxAgeMs = ttlMs()): Promise<MarketDashboardData | null> {
  const now = Date.now();

  if (memorySnapshot && now - memorySnapshot.builtAt < maxAgeMs) {
    return memorySnapshot.data;
  }

  try {
    const parsed = JSON.parse(await readFile(snapshotPath(), "utf8")) as CachedSnapshot;
    if (parsed && typeof parsed.builtAt === "number" && parsed.data) {
      memorySnapshot = parsed;
      if (now - parsed.builtAt < maxAgeMs) {
        return parsed.data;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * The most recent snapshot regardless of age (memory, else disk). Lets the
 * request handler keep serving the full pre-warmed list while a background
 * refresh runs, instead of downgrading to a tiny inline slice once the snapshot
 * goes stale.
 */
export async function readLastSnapshot(): Promise<MarketDashboardData | null> {
  if (memorySnapshot) {
    return memorySnapshot.data;
  }

  try {
    const parsed = JSON.parse(await readFile(snapshotPath(), "utf8")) as CachedSnapshot;
    if (parsed && typeof parsed.builtAt === "number" && parsed.data) {
      memorySnapshot = parsed;
      return parsed.data;
    }
  } catch {
    return null;
  }

  return null;
}

export async function writeDashboardSnapshot(data: MarketDashboardData): Promise<void> {
  const snapshot: CachedSnapshot = { builtAt: Date.now(), data };
  memorySnapshot = snapshot;

  const path = snapshotPath();

  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(snapshot), "utf8");
  } catch {
    // A read-only deploy filesystem (e.g. Vercel) is fine — the in-memory copy
    // still serves warm invocations; cold ones rebuild live.
  }
}
