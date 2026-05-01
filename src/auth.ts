// ============================================================
// API Key authentication for incoming requests to this adapter
// ============================================================

import type { Env } from "./types";

/**
 * Validate the incoming request's Authorization header against env.API_KEY.
 * Returns null on success, or a Response with 401/403 on failure.
 */
export function authenticateRequest(
  request: Request,
  env: Env
): Response | null {
  const authHeader = request.headers.get("Authorization");

  if (!authHeader) {
    return jsonError(
      401,
      "Missing API key. Include 'Authorization: Bearer YOUR_API_KEY' header."
    );
  }

  if (!authHeader.startsWith("Bearer ")) {
    return jsonError(
      401,
      "Invalid API key format. Use 'Authorization: Bearer YOUR_API_KEY'."
    );
  }

  const token = authHeader.slice(7);
  if (!env.API_KEY || token !== env.API_KEY) {
    return jsonError(401, "Invalid API key.");
  }

  return null; // Auth OK
}

/** Return an OpenAI-style error JSON response. */
export function jsonError(
  status: number,
  message: string,
  type = "authentication_error"
): Response {
  return new Response(
    JSON.stringify({
      error: { message, type, code: status, param: null },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    }
  );
}
