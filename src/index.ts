// ============================================================
// Worker Entry Point — routing, CORS, and health check
// ============================================================

import type { Env } from "./types";
import { authenticateRequest } from "./auth";
import { jsonError } from "./auth";
import { handleModels } from "./handlers/models";
import { handleChatCompletions } from "./handlers/chat";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return handleCORS();
    }

    // Health check — no auth needed
    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        JSON.stringify({
          status: "ok",
          message: "Vertex2OpenAI adapter is running on Cloudflare Workers.",
        }),
        {
          headers: corsHeaders({ "Content-Type": "application/json" }),
        }
      );
    }

    // All /v1/* routes require authentication
    if (url.pathname.startsWith("/v1/")) {
      const authResult = authenticateRequest(request, env);
      if (authResult) return withCORS(authResult);
    }

    // Route matching
    try {
      let response: Response;

      switch (url.pathname) {
        case "/v1/models":
          if (request.method !== "GET") {
            return withCORS(jsonError(405, "Method not allowed.", "invalid_request_error"));
          }
          response = await handleModels(env);
          break;

        case "/v1/chat/completions":
          if (request.method !== "POST") {
            return withCORS(jsonError(405, "Method not allowed.", "invalid_request_error"));
          }
          response = await handleChatCompletions(request, env);
          break;

        default:
          response = jsonError(404, `Unknown endpoint: ${url.pathname}`, "not_found");
      }

      return withCORS(response);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Unhandled error: ${msg}`);
      return withCORS(
        jsonError(500, `Internal server error: ${msg}`, "server_error")
      );
    }
  },
} satisfies ExportedHandler<Env>;

// ----- CORS Helpers -----

function handleCORS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    ...extra,
  };
}

function withCORS(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
