import { buildFreshKisDashboard, buildKisDashboard } from "../../server/kisDashboard";

type ApiRequest = { method?: string; query?: Record<string, string | string[] | undefined> };

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

export default async function handler(request: { method?: string }, response: ApiResponse) {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const typedRequest = request as ApiRequest;
    const freshValue = typedRequest.query?.fresh;
    const fresh = (Array.isArray(freshValue) ? freshValue[0] : freshValue) === "1";
    writeJson(response, 200, fresh ? await buildFreshKisDashboard() : await buildKisDashboard());
  } catch (error) {
    const message = error instanceof Error ? error.message : "KIS dashboard request failed.";
    writeJson(response, 502, { error: message });
  }
}
