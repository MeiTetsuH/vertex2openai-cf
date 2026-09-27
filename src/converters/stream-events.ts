import type { OpenAIUsage } from "../types";

export type ToolCallDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
  thought_signature?: string;
  extra_content?: { google?: { thought_signature?: string } };
};

/** Internal events stay as objects until the final wire format is selected. */
export interface ChatStreamChunk {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: ToolCallDelta[];
      extra_content?: unknown;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
  error?: unknown;
  [key: string]: unknown;
}

export type ChatStreamSink = (
  event: ChatStreamChunk | "[DONE]",
  controller: TransformStreamDefaultController<Uint8Array>
) => void;

export function createChatSseSink(): ChatStreamSink {
  const encoder = new TextEncoder();
  return (event, controller) => {
    const data = event === "[DONE]" ? event : JSON.stringify(event);
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  };
}

export function streamError(message: string): ChatStreamChunk {
  return { error: { type: "server_error", code: "upstream_stream_error", message } };
}
