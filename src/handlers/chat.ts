// ============================================================
// POST /v1/chat/completions handler
// ============================================================

import type { Env, OpenAIRequest } from "../types";
import { jsonError } from "../auth";
import { validateRequestShape } from "../validation";
import {
  dispatchToVertex,
  errorMessage,
  JSON_HEADERS,
  SSE_HEADERS,
} from "../vertex/dispatch";
import { parseModelName } from "../converters/request";
import { processOpenAIResponse, processVertexResponse } from "../converters/response";
import {
  createStreamTransformer,
  createVertexStreamTransformer,
} from "../converters/streaming";

/**
 * Handle POST /v1/chat/completions.
 */
export async function handleChatCompletions(
  request: Request,
  env: Env
): Promise<Response> {
  let body: OpenAIRequest;
  try {
    body = (await request.json()) as OpenAIRequest;
  } catch {
    return jsonError(400, "Invalid JSON in request body.", "invalid_request_error");
  }

  const shapeError = validateRequestShape(body, false);
  if (shapeError) return jsonError(400, shapeError.message, "invalid_request_error", shapeError.param);

  if (!body.model || typeof body.model !== "string") {
    return jsonError(400, "Missing required field: model.", "invalid_request_error");
  }
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, "Missing required field: messages.", "invalid_request_error");
  }

  const modelInfo = parseModelName(body.model);
  const stream = Boolean(body.stream);
  console.log(
    `Chat request: model=${body.model}, base=${modelInfo.baseModel}, stream=${stream}`
  );

  const dispatched = await dispatchToVertex(env, body, modelInfo, stream);
  if (!dispatched.ok) return dispatched.error;

  const { upstream, nativeVertex } = dispatched;

  if (stream) {
    const transformer = nativeVertex
      ? createVertexStreamTransformer(body.model)
      : createStreamTransformer(body.model);
    return new Response(upstream.body!.pipeThrough(transformer), {
      headers: SSE_HEADERS,
    });
  }

  let data: Record<string, unknown>;
  try {
    data = (await upstream.json()) as Record<string, unknown>;
  } catch (e) {
    return jsonError(
      502,
      `Malformed response from Vertex AI: ${errorMessage(e)}`,
      "server_error"
    );
  }

  const result = nativeVertex
    ? processVertexResponse(data, body.model)
    : processOpenAIResponse(data, body.model);

  return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
}
