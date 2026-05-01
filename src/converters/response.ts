// ============================================================
// Vertex AI → OpenAI response conversion (non-streaming)
// ============================================================

import type {
  OpenAIResponse,
  OpenAIChoice,
  OpenAIResponseMessage,
  OpenAIUsage,
  VertexPart,
  VertexResponse,
} from "../types";
import { convertFunctionCallsToOpenAI } from "./tools";

const THINKING_TAG = "vertex_think_tag";
const OPEN_TAG = `<${THINKING_TAG}>`;
const CLOSE_TAG = `</${THINKING_TAG}>`;

/**
 * Extract reasoning content from thinking tags.
 * Returns [reasoning, remainingContent].
 */
export function extractReasoningByTags(text: string): [string, string] {
  if (!text) return ["", ""];
  const re = new RegExp(
    `<${THINKING_TAG}>([\\s\\S]*?)</${THINKING_TAG}>`,
    "g"
  );
  const parts: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) parts.push(m[1]);
  const normal = text.replace(re, "").trim();
  return [parts.join("").trim(), normal];
}

/**
 * Process an OpenAI-compatible JSON response from Vertex,
 * extracting reasoning tags and normalizing the format.
 */
export function processOpenAIResponse(
  data: Record<string, unknown>,
  requestModel: string
): OpenAIResponse {
  const choices = (data.choices as Record<string, unknown>[]) || [];
  const processed: OpenAIChoice[] = [];

  for (const c of choices) {
    const msg = (c.message as Record<string, unknown>) || {};
    const raw = msg.content as string | null;
    const out: OpenAIResponseMessage = { role: "assistant", content: raw ?? null };

    if (typeof raw === "string" && raw.length > 0) {
      const [reasoning, content] = extractReasoningByTags(raw);
      out.content = content;
      if (reasoning) out.reasoning_content = reasoning;
    }

    if (msg.tool_calls) {
      out.tool_calls = msg.tool_calls as OpenAIResponseMessage["tool_calls"];
      out.content = null;
    }

    processed.push({
      index: (c.index as number) ?? 0,
      message: out,
      finish_reason: (c.finish_reason as string) ?? "stop",
    });
  }

  const u = data.usage as Record<string, number> | undefined;
  const usage: OpenAIUsage = {
    prompt_tokens: u?.prompt_tokens ?? 0,
    completion_tokens: u?.completion_tokens ?? 0,
    total_tokens: u?.total_tokens ?? 0,
  };

  return {
    id: (data.id as string) ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: (data.created as number) ?? Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: processed,
    usage,
  };
}

function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
      return "tool_calls";
    default:
      return reason ? reason.toLowerCase() : "stop";
  }
}

function extractParts(parts: VertexPart[]): {
  content: string;
  reasoning: string;
} {
  const content: string[] = [];
  const reasoning: string[] = [];

  for (const part of parts) {
    if (part.text) {
      if (part.thought) {
        reasoning.push(part.text);
      } else {
        content.push(part.text);
      }
    } else if (part.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || "application/octet-stream";
      content.push(`data:${mimeType};base64,${part.inlineData.data}`);
    }
  }

  return {
    content: content.join(""),
    reasoning: reasoning.join(""),
  };
}

/**
 * Process a native Vertex generateContent response into OpenAI format.
 */
export function processVertexResponse(
  data: VertexResponse,
  requestModel: string
): OpenAIResponse {
  const responseId = `chatcmpl-${Date.now()}`;
  const choices: OpenAIChoice[] = [];

  for (const [index, candidate] of (data.candidates || []).entries()) {
    const parts = candidate.content?.parts || [];
    const { content, reasoning } = extractParts(parts);
    const message: OpenAIResponseMessage = {
      role: "assistant",
      content: content || null,
    };

    if (reasoning) message.reasoning_content = reasoning;

    const toolCalls = convertFunctionCallsToOpenAI(parts, responseId, index);
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
      message.content = content || null;
    }

    choices.push({
      index,
      message,
      finish_reason: mapFinishReason(candidate.finishReason),
    });
  }

  if (choices.length === 0) {
    choices.push({
      index: 0,
      message: { role: "assistant", content: null },
      finish_reason: "stop",
    });
  }

  const usage: OpenAIUsage = {
    prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
    completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
  };

  return {
    id: responseId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices,
    usage,
  };
}
