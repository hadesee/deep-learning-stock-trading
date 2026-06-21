import { getCandidateAnalysisStatus, startCandidateAnalysis } from "../../server/pipelineRunner";

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

// The analysis runs for minutes — far past any proxy/tunnel request limit (a
// Cloudflare Tunnel returns 524 at ~100s). So POST starts the background job and
// returns immediately; GET reports status. Clients poll GET until it settles.
export default async function handler(request: { method?: string }, response: ApiResponse) {
  try {
    if (request.method === "POST") {
      writeJson(response, 200, startCandidateAnalysis());
    } else if (request.method === "GET") {
      writeJson(response, 200, getCandidateAnalysisStatus());
    } else {
      writeJson(response, 405, { error: "Method not allowed" });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Candidate analysis failed.";
    writeJson(response, 502, { error: message });
  }
}
