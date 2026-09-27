// ============================================================
// Normalized Chat chunks -> Responses API typed SSE events
// ============================================================

import type {
  ResponsesRequest,
  ResponseObject,
  ResponseOutputItem,
  ResponseUsage,
  ResponseItemStatus,
} from "../types";
import { incompleteReason, makeResponseId } from "./responses";
import { readToolCallSignature } from "./thought-signature";
import { SseLineBuffer } from "./sse-lines";
import { streamError, type ChatStreamChunk, type ChatStreamSink, type ToolCallDelta } from "./stream-events";

interface PendingToolCall {
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  args: string;
  signature?: string;
}

const EMPTY_USAGE: ResponseUsage = {
  input_tokens: 0,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 0,
};

/**
 * Wrap the normalized Chat Completions objects this adapter produces in the
 * Responses API's typed event stream. Every event carries an incrementing
 * `sequence_number`, and items are opened and closed in the order the model
 * emits them: reasoning, message, then function calls.
 */
export function createResponsesStreamSink(
  request: ResponsesRequest,
  model: string
): ChatStreamSink {
  const encoder = new TextEncoder();

  const responseId = makeResponseId();
  const createdAt = Math.floor(Date.now() / 1000);
  const outputItems = new Map<number, ResponseOutputItem>();
  let failure: ResponseObject["error"] = null;
  let sequence = 0;
  let outputIndex = 0;
  let started = false;
  let finished = false;

  let reasoningItemId: string | null = null;
  let reasoningIndex = 0;
  let reasoningText = "";

  let messageItemId: string | null = null;
  let messageIndex = 0;
  let messageText = "";
  let outputText = "";

  const toolCalls = new Map<number, PendingToolCall>();
  let finishReason: string | null = null;
  let usage: ResponseUsage = EMPTY_USAGE;

  type Controller = TransformStreamDefaultController<Uint8Array>;

  function emit(event: Record<string, unknown>, controller: Controller) {
    const payload = { ...event, sequence_number: sequence++ };
    // Responses events are named on the SSE `event:` line as well as in `type`.
    controller.enqueue(
      encoder.encode(
        `event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`
      )
    );
  }

  function snapshot(
    status: ResponseObject["status"],
    output: ResponseOutputItem[]
  ): ResponseObject {
    const reason =
      status === "incomplete" ? incompleteReason(finishReason) : undefined;
    return {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model,
      output,
      output_text: outputText,
      error: failure,
      incomplete_details: reason ? { reason } : null,
      instructions: request.instructions ?? null,
      max_output_tokens: request.max_output_tokens ?? null,
      parallel_tool_calls: request.parallel_tool_calls ?? true,
      previous_response_id: request.previous_response_id ?? null,
      reasoning: request.reasoning ?? null,
      temperature: request.temperature ?? null,
      text: request.text ?? { format: { type: "text" } },
      tool_choice: request.tool_choice ?? "auto",
      tools: request.tools ?? [],
      top_p: request.top_p ?? null,
      metadata: request.metadata ?? {},
      usage,
    };
  }

  function start(controller: Controller) {
    if (started) return;
    started = true;
    const initial = snapshot("in_progress", []);
    emit({ type: "response.created", response: initial }, controller);
    emit({ type: "response.in_progress", response: initial }, controller);
  }

  // ----- reasoning item -----

  function openReasoning(controller: Controller) {
    if (reasoningItemId) return;
    reasoningIndex = outputIndex++;
    reasoningItemId = `rs_${responseId}_${reasoningIndex}`;
    reasoningText = "";
    emit(
      {
        type: "response.output_item.added",
        output_index: reasoningIndex,
        item: {
          id: reasoningItemId,
          type: "reasoning",
          summary: [],
          content: [],
          status: "in_progress",
        },
      },
      controller
    );
  }

  function closeReasoning(controller: Controller, status: ResponseItemStatus = "completed") {
    if (!reasoningItemId) return;
    const item = {
      id: reasoningItemId,
      type: "reasoning" as const,
      summary: [{ type: "summary_text" as const, text: reasoningText }],
      content: [{ type: "reasoning_text", text: reasoningText }],
      status,
    };
    outputItems.set(reasoningIndex, item);
    emit({ type: "response.output_item.done", output_index: reasoningIndex, item }, controller);
    reasoningItemId = null;
  }

  // ----- message item -----

  function openMessage(controller: Controller) {
    if (messageItemId) return;
    messageIndex = outputIndex++;
    messageItemId = `msg_${responseId}_${messageIndex}`;
    messageText = "";
    emit(
      {
        type: "response.output_item.added",
        output_index: messageIndex,
        item: {
          id: messageItemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      controller
    );
    emit(
      {
        type: "response.content_part.added",
        item_id: messageItemId,
        output_index: messageIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      controller
    );
  }

  function closeMessage(controller: Controller, status: ResponseItemStatus) {
    if (!messageItemId) return;
    const part = { type: "output_text", text: messageText, annotations: [] };
    emit(
      {
        type: "response.output_text.done",
        item_id: messageItemId,
        output_index: messageIndex,
        content_index: 0,
        text: messageText,
        logprobs: [],
      },
      controller
    );
    emit(
      {
        type: "response.content_part.done",
        item_id: messageItemId,
        output_index: messageIndex,
        content_index: 0,
        part,
      },
      controller
    );
    const item = {
      id: messageItemId, type: "message" as const, role: "assistant" as const,
      status, content: [{ type: "output_text" as const, text: messageText, annotations: [] }],
    };
    outputItems.set(messageIndex, item);
    emit({ type: "response.output_item.done", output_index: messageIndex, item }, controller);
    messageItemId = null;
  }

  // ----- function call items -----

  function handleToolCallDelta(delta: ToolCallDelta, controller: Controller) {
    const index = delta.index ?? 0;
    let pending = toolCalls.get(index);
    // The OpenAI-compatible endpoint nests the signature under extra_content;
    // the native path puts it on the call directly.
    const signature = readToolCallSignature(delta);

    if (!pending) {
      // Reasoning and text are finished once tool calls begin.
      closeReasoning(controller);
      closeMessage(controller, "completed");

      pending = {
        outputIndex: outputIndex++,
        itemId: `fc_${responseId}_${index}`,
        callId: delta.id ?? `call_${responseId}_${index}`,
        name: delta.function?.name ?? "",
        args: "",
        signature,
      };
      toolCalls.set(index, pending);

      emit(
        {
          type: "response.output_item.added",
          output_index: pending.outputIndex,
          item: {
            id: pending.itemId,
            type: "function_call",
            call_id: pending.callId,
            name: pending.name,
            arguments: "",
            status: "in_progress",
          },
        },
        controller
      );
    }

    if (delta.function?.name) pending.name = delta.function.name;
    if (signature) pending.signature = signature;

    const argsDelta = delta.function?.arguments;
    if (argsDelta) {
      pending.args += argsDelta;
      emit(
        {
          type: "response.function_call_arguments.delta",
          item_id: pending.itemId,
          output_index: pending.outputIndex,
          delta: argsDelta,
        },
        controller
      );
    }
  }

  function closeToolCalls(controller: Controller, status: ResponseItemStatus) {
    for (const pending of toolCalls.values()) {
      emit(
        {
          type: "response.function_call_arguments.done",
          item_id: pending.itemId,
          output_index: pending.outputIndex,
          arguments: pending.args,
        },
        controller
      );
      const item = {
        id: pending.itemId,
        type: "function_call" as const,
        call_id: pending.callId,
        name: pending.name,
        arguments: pending.args,
        status,
        ...(pending.signature ? { thought_signature: pending.signature } : {}),
      };
      outputItems.set(pending.outputIndex, item);
      emit({ type: "response.output_item.done", output_index: pending.outputIndex, item }, controller);
    }
  }

  function finish(controller: Controller) {
    if (finished) return;
    finished = true;
    start(controller);

    const incomplete = incompleteReason(finishReason) !== undefined;
    const itemStatus = incomplete || failure ? "incomplete" : "completed";
    closeReasoning(controller, itemStatus);
    closeMessage(controller, itemStatus);
    closeToolCalls(controller, itemStatus);
    const output = [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    const status = failure ? "failed" : incomplete ? "incomplete" : "completed";
    emit({ type: `response.${status}`, response: snapshot(status, output) }, controller);
  }

  function fail(error: unknown, controller: Controller) {
    const message = error && typeof error === "object" && "message" in error
      ? String(error.message) : "Vertex AI stream failed.";
    failure = { code: "server_error", message };
    finish(controller);
  }

  function processChunk(data: ChatStreamChunk, controller: Controller) {
    if (data.usage) {
      usage = {
        input_tokens: data.usage.prompt_tokens ?? 0,
        input_tokens_details: {
          cached_tokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
        },
        output_tokens: data.usage.completion_tokens ?? 0,
        output_tokens_details: {
          reasoning_tokens:
            data.usage.completion_tokens_details?.reasoning_tokens ?? 0,
        },
        total_tokens: data.usage.total_tokens ?? 0,
      };
    }

    const choice = data.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta ?? {};

    if (delta.reasoning_content) {
      closeMessage(controller, "completed");
      openReasoning(controller);
      reasoningText += delta.reasoning_content;
      emit(
        {
          type: "response.reasoning_text.delta",
          item_id: reasoningItemId,
          output_index: reasoningIndex,
          content_index: 0,
          delta: delta.reasoning_content,
        },
        controller
      );
    }

    if (delta.content) {
      closeReasoning(controller);
      openMessage(controller);
      messageText += delta.content;
      outputText += delta.content;
      emit(
        {
          type: "response.output_text.delta",
          item_id: messageItemId,
          output_index: messageIndex,
          content_index: 0,
          delta: delta.content,
          logprobs: [],
        },
        controller
      );
    }

    for (const tc of delta.tool_calls ?? []) {
      handleToolCallDelta(tc, controller);
    }
  }

  return (event, controller) => {
    if (finished) return;
    start(controller);
    if (event === "[DONE]") {
      if (!finishReason) fail({ message: "Vertex AI stream ended before a finish reason was received." }, controller);
      else finish(controller);
    } else if (event.error) {
      fail(event.error, controller);
    } else {
      processChunk(event, controller);
    }
  };
}

/** Compatibility bridge for an already encoded Chat Completions SSE stream. */
export function createResponsesStreamTransformer(
  request: ResponsesRequest,
  model: string
): TransformStream<Uint8Array, Uint8Array> {
  const input = new SseLineBuffer();
  const consume = createResponsesStreamSink(request, model);
  function processLine(line: string, controller: TransformStreamDefaultController<Uint8Array>) {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") {
      consume(payload, controller);
      return;
    }
    let event: ChatStreamChunk;
    try {
      event = JSON.parse(payload);
      if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid frame");
    } catch {
      consume(streamError("Malformed JSON frame from Vertex AI."), controller);
      return;
    }
    consume(event, controller);
  }
  return new TransformStream({
    transform(chunk, controller) {
      for (const line of input.push(chunk)) processLine(line, controller);
    },
    flush(controller) {
      const tail = input.rest();
      if (tail) processLine(tail, controller);
      consume("[DONE]", controller);
    },
  });
}
