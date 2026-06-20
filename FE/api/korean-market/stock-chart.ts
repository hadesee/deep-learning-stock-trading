import { buildKisStockChart } from "../../server/kisDashboard";

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

function queryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(request: ApiRequest, response: ApiResponse) {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const symbol = queryValue(request.query?.symbol) ?? queryValue(request.query?.code);
  if (!symbol) {
    writeJson(response, 400, { error: "symbol query parameter is required." });
    return;
  }

  try {
    writeJson(response, 200, await buildKisStockChart(symbol));
  } catch (error) {
    const message = error instanceof Error ? error.message : "KIS stock chart request failed.";
    writeJson(response, 502, { error: message });
  }
}
