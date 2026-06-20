import { getCandidatesPayload } from "../server/pipelineResults";

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
    writeJson(response, 200, await getCandidatesPayload());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Candidates request failed.";
    writeJson(response, 502, { error: message });
  }
}
