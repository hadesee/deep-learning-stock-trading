import { refreshDashboardSnapshot } from "../../server/kisDashboard";

declare const process: { env: Record<string, string | undefined> };

type ApiRequest = { method?: string; query?: Record<string, string | string[] | undefined>; headers?: Record<string, string | string[] | undefined> };

type ApiResponse = {
  end: (body: string) => void;
  setHeader: (name: string, value: string) => void;
  statusCode: number;
};

function writeJson(response: ApiResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isAuthorized(request: ApiRequest): boolean {
  const expected = process.env.SNAPSHOT_REFRESH_KEY;
  // No key configured → allow (local/dev). Once set, require it so the public
  // endpoint can't be abused to trigger hundreds of upstream KIS calls.
  if (!expected) {
    return true;
  }

  const fromQuery = request.query?.key;
  const provided =
    (Array.isArray(fromQuery) ? fromQuery[0] : fromQuery) ?? headerValue(request.headers?.["x-refresh-key"]);
  return provided === expected;
}

/**
 * Vercel Cron invokes the configured path with GET and, when a `CRON_SECRET`
 * env var exists, an `Authorization: Bearer <CRON_SECRET>` header. GET is only
 * honored for that authenticated cron caller — everyone else uses POST.
 */
function isCronRequest(request: ApiRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return false;
  }

  return headerValue(request.headers?.authorization) === `Bearer ${secret}`;
}

/**
 * Cache-warming batch endpoint. Point a scheduler (Vercel Cron, GitHub Action,
 * OS cron) at this during market hours to rebuild the full KOSPI200 snapshot
 * the dashboard serves. Long-running: keep `KIS_SNAPSHOT_UNIVERSE_SIZE` within
 * the platform's function timeout.
 */
export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "POST" && request.method !== "GET") {
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const authorized = request.method === "GET" ? isCronRequest(request) : isAuthorized(request);
  if (!authorized) {
    writeJson(response, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const data = await refreshDashboardSnapshot();
    writeJson(response, 200, { generatedAt: data.generatedAt, stocks: data.stocks.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Snapshot refresh failed.";
    writeJson(response, 502, { error: message });
  }
}
