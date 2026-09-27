// ============================================================
// SSE Streaming response processing
// ============================================================

import type { OpenAIUsage, VertexPart, VertexResponse } from "../types";
import { convertFunctionCallsToOpenAI } from "./tools";
import { mapFinishReason } from "./finish-reason";
import { buildUsage, normalizeUsage } from "./response";
import { SseLineBuffer } from "./sse-lines";
import { createChatSseSink, streamError, type ChatStreamSink, type ChatStreamChunk } from "./stream-events";

const THINKING_TAG = "vertex_think_tag";

/**
 * Processor for extracting reasoning content from streamed chunks.
 * Tracks tag state across multiple chunks.
 */
export class StreamingReasoningProcessor {
  private openTag = `<${THINKING_TAG}>`;
  private closeTag = `</${THINKING_TAG}>`;
  private buffer = "";
  private insideTag = false;
  private partialTagBuffer = "";
  // Vertex follows the closing tag with "\n\n"; the non-streaming path trims
  // it, so strip whitespace ahead of the first visible text after a thought.
  private sawThought = false;
  private sawVisible = false;

  private visible(text: string): string {
    if (this.sawThought && !this.sawVisible) text = text.replace(/^\s+/, "");
    if (/\S/.test(text)) this.sawVisible = true;
    return text;
  }

  /**
   * Process a content chunk, separating reasoning from normal content.
   * Returns [processedContent, currentReasoning].
   */
  processChunk(content: string): [string, string] {
    if (this.partialTagBuffer) {
      content = this.partialTagBuffer + content;
      this.partialTagBuffer = "";
    }

    this.buffer += content;
    let processed = "";
    let reasoning = "";

    while (this.buffer.length > 0) {
      if (!this.insideTag) {
        const openPos = this.buffer.indexOf(this.openTag);
        if (openPos === -1) {
          // Check for partial tag match at end
          let partial = false;
          for (let i = 1; i < Math.min(this.openTag.length, this.buffer.length + 1); i++) {
            if (this.buffer.slice(-i) === this.openTag.slice(0, i)) {
              if (this.buffer.length > i) {
                processed += this.buffer.slice(0, -i);
              }
              this.partialTagBuffer = this.buffer.slice(-i);
              this.buffer = "";
              partial = true;
              break;
            }
          }
          if (!partial) {
            processed += this.buffer;
            this.buffer = "";
          }
          break;
        } else {
          processed += this.buffer.slice(0, openPos);
          this.buffer = this.buffer.slice(openPos + this.openTag.length);
          this.insideTag = true;
          this.sawThought = true;
        }
      } else {
        const closePos = this.buffer.indexOf(this.closeTag);
        if (closePos === -1) {
          // Check for partial close tag
          let partial = false;
          for (let i = 1; i < Math.min(this.closeTag.length, this.buffer.length + 1); i++) {
            if (this.buffer.slice(-i) === this.closeTag.slice(0, i)) {
              if (this.buffer.length > i) {
                reasoning += this.buffer.slice(0, -i);
              }
              this.partialTagBuffer = this.buffer.slice(-i);
              this.buffer = "";
              partial = true;
              break;
            }
          }
          if (!partial) {
            reasoning += this.buffer;
            this.buffer = "";
          }
          break;
        } else {
          reasoning += this.buffer.slice(0, closePos);
          this.buffer = this.buffer.slice(closePos + this.closeTag.length);
          this.insideTag = false;
        }
      }
    }

    return [this.visible(processed), reasoning];
  }

  /** Flush remaining buffered content. Returns [content, reasoning]. */
  flushRemaining(): [string, string] {
    // A half-received tag belongs to whichever side it was cut off in.
    const rest = this.buffer + this.partialTagBuffer;
    this.buffer = "";
    this.partialTagBuffer = "";
    if (this.insideTag) {
      this.insideTag = false;
      return ["", rest];
    }
    return [this.visible(rest), ""];
  }
}

/** Decode and normalize the OpenAI-compatible upstream stream. */
export function createStreamTransformer(
  requestModel: string,
  emit: ChatStreamSink = createChatSseSink()
): TransformStream<Uint8Array, Uint8Array> {
  const input = new SseLineBuffer();
  const processor = new StreamingReasoningProcessor();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  let doneSent = false;
  let finishEmitted = false;
  type Controller = TransformStreamDefaultController<Uint8Array>;

  function flushText(controller: Controller) {
    const [content, reasoning] = processor.flushRemaining();
    if (reasoning) emit(makeChunkFromBase(responseBase, requestModel, { reasoning_content: reasoning }, null), controller);
    if (content) emit(makeChunkFromBase(responseBase, requestModel, { content }, null), controller);
  }

  function finish(controller: Controller) {
    if (doneSent) return;
    flushText(controller);
    if (!finishEmitted) {
      emit(streamError("Vertex AI stream ended before a finish_reason was received."), controller);
    }
    emit("[DONE]", controller);
    doneSent = true;
  }

  function fail(error: ChatStreamChunk, controller: Controller) {
    flushText(controller);
    emit(error, controller);
    emit("[DONE]", controller);
    doneSent = true;
  }

  function processLine(line: string, controller: Controller) {
    if (doneSent || !line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      finish(controller);
      return;
    }

    let data: ChatStreamChunk;
    try {
      data = JSON.parse(payload);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid frame");
    } catch {
      fail(streamError("Malformed JSON frame from Vertex AI."), controller);
      return;
    }
    if (data.error) {
      fail({ error: data.error }, controller);
      return;
    }
    if (data.id) responseBase.id = data.id;
    if (data.created) responseBase.created = data.created;
    if (data.usage) data.usage = normalizeUsage({ ...data.usage });
    data.model = requestModel;
    const choice = data.choices?.[0];
    if (!choice) {
      emit(data, controller);
      return;
    }

    const delta = choice.delta ?? {};
    choice.delta = delta;
    const content = typeof delta.content === "string" ? delta.content : "";
    const finishReason = choice.finish_reason ?? null;
    choice.finish_reason = finishReason;
    delete delta.extra_content;

    let text = "";
    let reasoning = "";
    if (content) [text, reasoning] = processor.processChunk(content);
    if (finishReason) {
      const [restText, restReasoning] = processor.flushRemaining();
      text += restText;
      reasoning += restReasoning;
      finishEmitted = true;
    }
    if (reasoning) {
      emit(makeChunkFromBase(data, requestModel, { reasoning_content: reasoning }, null), controller);
    }
    if (text) delta.content = text;
    else delete delta.content;
    const onlyReasoning = content && !text && !finishReason && !data.usage && Object.keys(delta).length === 0;
    if (!onlyReasoning) emit(data, controller);
  }

  const responseBase: ChatStreamChunk = { id: responseId };
  return new TransformStream({
    transform(chunk, controller) {
      for (const line of input.push(chunk)) processLine(line, controller);
    },
    flush(controller) {
      const tail = input.rest();
      if (tail) processLine(tail, controller);
      finish(controller);
    },
  });
}

/** Decode native Vertex frames without serializing an intermediate SSE stream. */
export function createVertexStreamTransformer(
  requestModel: string,
  emit: ChatStreamSink = createChatSseSink()
): TransformStream<Uint8Array, Uint8Array> {
  const input = new SseLineBuffer();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let doneSent = false;
  let sentRole = false;
  let toolCallIndex = 0;
  let sawToolCall = false;
  let finished = false;
  type Controller = TransformStreamDefaultController<Uint8Array>;

  function enqueueChunk(controller: Controller, delta: Record<string, unknown>, finishReason: string | null, usage?: OpenAIUsage) {
    emit({
      id: responseId, object: "chat.completion.chunk", created, model: requestModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    }, controller);
  }

  function finish(controller: Controller) {
    if (doneSent) return;
    if (!finished) emit(streamError("Vertex AI stream ended before a finishReason was received."), controller);
    emit("[DONE]", controller);
    doneSent = true;
  }

  function processVertexChunk(data: VertexResponse & { error?: unknown }, controller: Controller) {
    if (data.error) {
      emit({ error: data.error }, controller);
      finished = true;
      finish(controller);
      return;
    }
    if (!data.candidates?.length && data.promptFeedback?.blockReason) {
      if (!sentRole) enqueueChunk(controller, { role: "assistant" }, null);
      sentRole = true;
      enqueueChunk(controller, {}, "content_filter", data.usageMetadata ? buildUsage(data.usageMetadata) : undefined);
      finished = true;
      return;
    }
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    if (!sentRole && (parts.length > 0 || candidate?.finishReason)) {
      enqueueChunk(controller, { role: "assistant" }, null);
      sentRole = true;
    }
    for (const part of parts) {
      if (part.text) {
        enqueueChunk(controller, part.thought ? { reasoning_content: part.text } : { content: part.text }, null);
      } else if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || "application/octet-stream";
        enqueueChunk(controller, { content: `data:${mimeType};base64,${part.inlineData.data}` }, null);
      }
    }
    const toolCalls = convertFunctionCallsToOpenAI(parts as VertexPart[], responseId, 0, toolCallIndex);
    for (const toolCall of toolCalls) {
      sawToolCall = true;
      enqueueChunk(controller, { tool_calls: [{ index: toolCallIndex, ...toolCall }] }, null);
      toolCallIndex++;
    }
    if (candidate?.finishReason) {
      enqueueChunk(controller, {}, mapFinishReason(candidate.finishReason, sawToolCall), data.usageMetadata ? buildUsage(data.usageMetadata) : undefined);
      finished = true;
    } else if (data.usageMetadata && !candidate) {
      emit({ id: responseId, object: "chat.completion.chunk", created, model: requestModel, choices: [], usage: buildUsage(data.usageMetadata) }, controller);
    }
  }

  function processLine(line: string, controller: Controller) {
    if (doneSent || !line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      finish(controller);
      return;
    }
    let data: VertexResponse;
    try {
      data = JSON.parse(payload);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid frame");
    } catch {
      emit(streamError("Malformed JSON frame from Vertex AI."), controller);
      finished = true;
      finish(controller);
      return;
    }
    processVertexChunk(data, controller);
  }

  return new TransformStream({
    transform(chunk, controller) {
      for (const line of input.push(chunk)) processLine(line, controller);
    },
    flush(controller) {
      const tail = input.rest();
      if (tail) processLine(tail, controller);
      finish(controller);
    },
  });
}

function makeChunkFromBase(
  base: ChatStreamChunk,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null
): ChatStreamChunk {
  return {
    id: base.id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: base.created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
