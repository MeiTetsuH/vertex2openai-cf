// ============================================================
// POST /v1/chat/completions handler
// ============================================================

import type { Env, OpenAIRequest } from "../types";
import { jsonError } from "../auth";
import {
  resolveCredentials,
  buildOpenAIEndpointUrl,
  buildExpressGenerateContentUrl,
  buildHeaders,
} from "../vertex/client";
import {
  parseModelName,
  buildOpenAICompatibleBody,
  buildVertexGenerateContentBody,
} from "../converters/request";
import { processOpenAIResponse, processVertexResponse } from "../converters/response";
import {
  createStreamTransformer,
  createVertexStreamTransformer,
} from "../converters/streaming";

/**
 * Handle POST /v1/chat/completions.
 * Proxies the request to Vertex AI's OpenAI-compatible endpoint.
 */
export async function handleChatCompletions(
  request: Request,
  env: Env
): Promise<Response> {
  // Parse request body
  let body: OpenAIRequest;
  try {
    body = (await request.json()) as OpenAIRequest;
  } catch {
    return jsonError(400, "Invalid JSON in request body.", "invalid_request_error");
  }

  if (!body.model) {
    return jsonError(400, "Missing required field: model.", "invalid_request_error");
  }
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonError(400, "Missing required field: messages.", "invalid_request_error");
  }

  // Parse model name
  const modelInfo = parseModelName(body.model);
  console.log(`Chat request: model=${body.model}, base=${modelInfo.baseModel}, stream=${body.stream}`);

  // Resolve credentials
  let creds;
  try {
    const credentialPreference = modelInfo.isExpress
      ? "express"
      : modelInfo.isPay
        ? "service_account"
        : undefined;
    creds = await resolveCredentials(env, credentialPreference);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Credential error: ${msg}`);
    return jsonError(500, msg, "server_error");
  }

  const useExpressNative = creds.authType === "express";
  const vertexBody = useExpressNative
    ? buildVertexGenerateContentBody(body, modelInfo)
    : buildOpenAICompatibleBody(body, modelInfo);
  const endpointUrl = useExpressNative
    ? buildExpressGenerateContentUrl(creds, modelInfo.baseModel, Boolean(body.stream))
    : buildOpenAIEndpointUrl(creds, "/chat/completions");
  const headers = buildHeaders(creds);

  console.log(`Proxying to: ${endpointUrl.replace(/key=[^&]+/, "key=***")}`);

  try {
    if (body.stream) {
      return await handleStreaming(
        endpointUrl,
        headers,
        vertexBody,
        body.model,
        useExpressNative
      );
    } else {
      return await handleNonStreaming(
        endpointUrl,
        headers,
        vertexBody,
        body.model,
        useExpressNative
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Vertex API error: ${msg}`);
    return jsonError(500, `Error calling Vertex AI: ${msg}`, "server_error");
  }
}

// ----- Non-Streaming -----

async function handleNonStreaming(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  requestModel: string,
  nativeVertex: boolean
): Promise<Response> {
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`Vertex error ${resp.status}: ${errText.slice(0, 500)}`);
    return jsonError(resp.status, `Vertex AI error: ${errText.slice(0, 500)}`, "server_error");
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const result = nativeVertex
    ? processVertexResponse(data, requestModel)
    : processOpenAIResponse(data, requestModel);

  return new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ----- Streaming -----

async function handleStreaming(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  requestModel: string,
  nativeVertex: boolean
): Promise<Response> {
  const requestBody = nativeVertex
    ? body
    : { ...(body as Record<string, unknown>), stream: true };

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`Vertex stream error ${resp.status}: ${errText.slice(0, 500)}`);
    return jsonError(resp.status, `Vertex AI error: ${errText.slice(0, 500)}`, "server_error");
  }

  if (!resp.body) {
    return jsonError(500, "No response body from Vertex AI.", "server_error");
  }

  // Pipe through the stream transformer
  const transformer = nativeVertex
    ? createVertexStreamTransformer(requestModel)
    : createStreamTransformer(requestModel);
  const transformed = resp.body.pipeThrough(transformer);

  return new Response(transformed, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
