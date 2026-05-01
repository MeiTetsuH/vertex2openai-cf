// ============================================================
// SSE Streaming response processing
// ============================================================

import type { VertexPart, VertexResponse } from "../types";
import { convertFunctionCallsToOpenAI } from "./tools";

const THINKING_TAG = "vertex_think_tag";

/**
 * Processor for extracting reasoning content from streamed chunks.
 * Tracks tag state across multiple chunks.
 */
export class StreamingReasoningProcessor {
  private openTag = `<${THINKING_TAG}>`;
  private closeTag = `</${THINKING_TAG}>`;
  private buffer = "";
  insideTag = false;
  private partialTagBuffer = "";

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

    return [processed, reasoning];
  }

  /** Flush remaining buffered content. Returns [content, reasoning]. */
  flushRemaining(): [string, string] {
    let content = "";
    let reasoning = "";

    if (this.partialTagBuffer) {
      content += this.partialTagBuffer;
      this.partialTagBuffer = "";
    }
    if (!this.insideTag) {
      content += this.buffer;
    } else {
      reasoning = this.buffer;
      this.insideTag = false;
    }
    this.buffer = "";
    return [content, reasoning];
  }
}

/**
 * Transform a Vertex AI SSE stream into an OpenAI-compatible SSE stream.
 * Reads from the upstream Response body line-by-line.
 */
export function createStreamTransformer(
  requestModel: string
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const processor = new StreamingReasoningProcessor();
  let leftover = "";

  return new TransformStream({
    transform(chunk, controller) {
      const text = leftover + decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      leftover = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();

        if (jsonStr === "[DONE]") {
          // Flush remaining
          const [remContent, remReasoning] = processor.flushRemaining();
          if (remReasoning) {
            const rp = makeChunk(requestModel, { reasoning_content: remReasoning }, null);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(rp)}\n\n`));
          }
          if (remContent) {
            const cp = makeChunk(requestModel, { content: remContent }, null);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(cp)}\n\n`));
          }
          // Send finish chunk
          const fp = makeChunk(requestModel, {}, "stop");
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(fp)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          return;
        }

        try {
          const data = JSON.parse(jsonStr);
          const choices = data.choices;
          if (!choices || !Array.isArray(choices) || choices.length === 0) {
            // Pass through non-choice chunks
            data.model = requestModel;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            continue;
          }

          const delta = choices[0].delta || {};
          const content = delta.content || "";
          const finishReason = choices[0].finish_reason;

          // Remove extra_content if present
          delete delta.extra_content;

          if (content) {
            const [processedContent, currentReasoning] = processor.processChunk(content);

            if (currentReasoning) {
              const rChunk = makeChunkFromBase(data, requestModel, { reasoning_content: currentReasoning }, null);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(rChunk)}\n\n`));
            }

            if (processedContent) {
              const fr = !processor.insideTag ? finishReason : null;
              const cChunk = makeChunkFromBase(data, requestModel, { content: processedContent }, fr);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(cChunk)}\n\n`));
            }
          } else if (delta.tool_calls) {
            // Pass through tool call deltas
            data.model = requestModel;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } else if (finishReason) {
            // Finish without content
            data.model = requestModel;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } else {
            // Empty delta, pass through
            data.model = requestModel;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    },

    flush(controller) {
      // Handle any remaining data
      if (leftover.trim()) {
        if (leftover.startsWith("data: ") && leftover.slice(6).trim() === "[DONE]") {
          const fp = makeChunk(requestModel, {}, "stop");
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(fp)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
      }
      const [remContent, remReasoning] = processor.flushRemaining();
      if (remReasoning) {
        const rp = makeChunk(requestModel, { reasoning_content: remReasoning }, null);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(rp)}\n\n`));
      }
      if (remContent) {
        const cp = makeChunk(requestModel, { content: remContent }, null);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(cp)}\n\n`));
      }
    },
  });
}

/**
 * Transform a native Vertex streamGenerateContent SSE stream into an
 * OpenAI-compatible chat.completion.chunk SSE stream.
 */
export function createVertexStreamTransformer(
  requestModel: string
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let leftover = "";
  let doneSent = false;
  let sentRole = false;
  const responseId = `chatcmpl-${Date.now()}`;

  function enqueueChunk(
    controller: TransformStreamDefaultController<Uint8Array>,
    delta: Record<string, unknown>,
    finishReason: string | null,
    usage?: Record<string, number>
  ) {
    const chunk = {
      id: responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  function processVertexChunk(
    data: VertexResponse,
    controller: TransformStreamDefaultController<Uint8Array>
  ) {
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    if (!sentRole && (parts.length > 0 || candidate?.finishReason)) {
      enqueueChunk(controller, { role: "assistant" }, null);
      sentRole = true;
    }

    for (const part of parts) {
      if (part.text) {
        enqueueChunk(
          controller,
          part.thought
            ? { reasoning_content: part.text }
            : { content: part.text },
          null
        );
      } else if (part.inlineData?.data) {
        const mimeType = part.inlineData.mimeType || "application/octet-stream";
        enqueueChunk(
          controller,
          { content: `data:${mimeType};base64,${part.inlineData.data}` },
          null
        );
      }
    }

    const toolCalls = convertFunctionCallsToOpenAI(
      parts as VertexPart[],
      responseId,
      0
    );
    for (const [index, toolCall] of toolCalls.entries()) {
      enqueueChunk(
        controller,
        {
          tool_calls: [
            {
              index,
              id: toolCall.id,
              type: toolCall.type,
              function: toolCall.function,
            },
          ],
        },
        null
      );
    }

    if (candidate?.finishReason) {
      const usage = data.usageMetadata
        ? {
            prompt_tokens: data.usageMetadata.promptTokenCount ?? 0,
            completion_tokens: data.usageMetadata.candidatesTokenCount ?? 0,
            total_tokens: data.usageMetadata.totalTokenCount ?? 0,
          }
        : undefined;
      enqueueChunk(controller, {}, mapVertexFinishReason(candidate.finishReason), usage);
    }
  }

  function processLine(
    line: string,
    controller: TransformStreamDefaultController<Uint8Array>
  ) {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      doneSent = true;
      return;
    }

    try {
      processVertexChunk(JSON.parse(payload) as VertexResponse, controller);
    } catch {
      // Skip malformed stream frames.
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      const text = leftover + decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      leftover = lines.pop() || "";

      for (const line of lines) {
        processLine(line.trimEnd(), controller);
      }
    },

    flush(controller) {
      const tail = leftover.trim();
      if (tail) processLine(tail, controller);
      if (!doneSent) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        doneSent = true;
      }
    },
  });
}

function mapVertexFinishReason(reason: string | undefined): string {
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

function makeChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null
) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function makeChunkFromBase(
  base: Record<string, unknown>,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null
) {
  return {
    id: base.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: base.created || Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
