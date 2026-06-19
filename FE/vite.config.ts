import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { buildKisDashboard, buildKisStockChart, refreshDashboardSnapshot } from "./server/kisDashboard";
import { getCandidatesPayload } from "./server/pipelineResults";
import { getCandidateAnalysisStatus, startCandidateAnalysis } from "./server/pipelineRunner";

declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

type DevRequest = { method?: string; url?: string };
type DevResponse = { end: (body: string) => void; setHeader: (name: string, value: string) => void; statusCode: number };

function writeJson(response: DevResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function jsonRoute(
  server: { middlewares: { use: (path: string, handler: (request: unknown, response: DevResponse) => void) => void } },
  path: string,
  allowedMethod: string,
  build: () => Promise<unknown>,
) {
  server.middlewares.use(path, async (request, response) => {
    const method = (request as { method?: string }).method;

    if (method !== allowedMethod) {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }

    try {
      writeJson(response, 200, await build());
    } catch (error) {
      const message = error instanceof Error ? error.message : `${path} request failed.`;
      writeJson(response, 502, { error: message });
    }
  });
}

function queryValue(request: DevRequest, key: string): string | undefined {
  const url = new URL(request.url ?? "", "http://localhost");
  return url.searchParams.get(key) ?? undefined;
}

function jsonRequestRoute(
  server: { middlewares: { use: (path: string, handler: (request: unknown, response: DevResponse) => void) => void } },
  path: string,
  allowedMethod: string,
  build: (request: DevRequest) => Promise<unknown>,
) {
  server.middlewares.use(path, async (request, response) => {
    const typedRequest = request as DevRequest;

    if (typedRequest.method !== allowedMethod) {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }

    try {
      writeJson(response, 200, await build(typedRequest));
    } catch (error) {
      const message = error instanceof Error ? error.message : `${path} request failed.`;
      writeJson(response, 502, { error: message });
    }
  });
}

function kisApiPlugin(): Plugin {
  return {
    configureServer(server) {
      jsonRoute(server, "/api/korean-market/dashboard", "GET", () => buildKisDashboard());
      jsonRoute(server, "/api/korean-market/refresh", "POST", () => refreshDashboardSnapshot());
      jsonRequestRoute(server, "/api/korean-market/stock-chart", "GET", (request) => {
        const symbol = queryValue(request, "symbol") ?? queryValue(request, "code");
        if (!symbol) {
          throw new Error("symbol query parameter is required.");
        }

        return buildKisStockChart(symbol);
      });
      // The analysis runs for minutes, so the request must not block: POST kicks
      // off (or re-attaches to) the background job and returns the current status
      // immediately; GET polls it. Registered before "/api/candidates" so the
      // prefix match resolves here first.
      server.middlewares.use("/api/candidates/run", async (request, response) => {
        const method = (request as { method?: string }).method;

        try {
          if (method === "POST") {
            writeJson(response, 200, startCandidateAnalysis());
          } else if (method === "GET") {
            writeJson(response, 200, getCandidateAnalysisStatus());
          } else {
            writeJson(response, 405, { error: "Method not allowed" });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "/api/candidates/run request failed.";
          writeJson(response, 502, { error: message });
        }
      });
      jsonRoute(server, "/api/candidates", "GET", () => getCandidatesPayload());
    },
    name: "kis-api",
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));

  return {
    plugins: [react(), kisApiPlugin()],
    server: {
      // Bind to all interfaces so the dev server is reachable over the LAN and
      // through a tunnel (Cloudflare Tunnel / ngrok), not just on localhost.
      host: true,
      // Honor a PORT env var (e.g. assigned by the preview harness) when present,
      // otherwise fall back to Vite's default (5173).
      port: process.env.PORT ? Number(process.env.PORT) : undefined,
      // Dev only: accept any Host header so dynamic tunnel domains
      // (*.trycloudflare.com, *.ngrok-free.app) aren't rejected by Vite's
      // host check. Does not affect production builds.
      allowedHosts: true,
    },
  };
});
