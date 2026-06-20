import { getStockNewsAnalysisStatus, startStockNewsAnalysis } from "../../server/pipelineRunner";

type ApiRequest = {
  method?: string;
  query?: { code?: string | string[]; ticker?: string | string[] };
};

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
  const ticker = queryValue(request.query?.ticker) ?? queryValue(request.query?.code);
  if (!ticker) {
    writeJson(response, 400, { error: "ticker query parameter is required." });
    return;
  }

  try {
    if (request.method === "POST") {
      writeJson(response, 200, startStockNewsAnalysis(ticker));
    } else if (request.method === "GET") {
      writeJson(response, 200, getStockNewsAnalysisStatus(ticker));
    } else {
      writeJson(response, 405, { error: "Method not allowed" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stock news analysis failed.";
    writeJson(response, 502, { error: message });
  }
}
