// ============================================================
// OpenAI → Vertex AI request conversion
// ============================================================

import type {
  OpenAIRequest,
  OpenAIMessage,
  OpenAIContentPart,
  VertexContent,
  VertexPart,
  VertexSafetySetting,
  VertexGenerationConfig,
  VertexRequest,
  ParsedModelInfo,
} from "../types";
import {
  convertToolsToVertex,
  convertToolChoiceToVertex,
} from "./tools";

// ----- Model Name Parsing -----

const EXPRESS_PREFIX = "[EXPRESS] ";
const PAY_PREFIX = "[PAY]";
const OPENAI_DIRECT_SUFFIX = "-openai";
const OPENAI_SEARCH_SUFFIX = "-openaisearch";

/**
 * Parse model name to extract base model and feature flags.
 */
export function parseModelName(model: string): ParsedModelInfo {
  let name = model;
  let isExpress = false;
  let isPay = false;

  // Strip prefixes
  if (name.startsWith(EXPRESS_PREFIX)) {
    isExpress = true;
    name = name.slice(EXPRESS_PREFIX.length);
  }
  if (name.startsWith(PAY_PREFIX)) {
    isPay = true;
    name = name.slice(PAY_PREFIX.length);
  }

  // Detect suffixes
  const isOpenAISearch = name.endsWith(OPENAI_SEARCH_SUFFIX);
  const isOpenAIDirect =
    name.endsWith(OPENAI_DIRECT_SUFFIX) || isOpenAISearch;
  const isSearch = name.endsWith("-search");
  const isNoThinking = name.endsWith("-nothinking");
  const isMaxThinking = name.endsWith("-max");
  const is2kImage = name.endsWith("-2k");
  const is4kImage = name.endsWith("-4k");

  // Strip suffixes to get base model
  let baseModel = name;
  const suffixes = [
    OPENAI_SEARCH_SUFFIX,
    OPENAI_DIRECT_SUFFIX,
    "-search",
    "-nothinking",
    "-max",
    "-2k",
    "-4k",
  ];
  for (const suffix of suffixes) {
    if (baseModel.endsWith(suffix)) {
      baseModel = baseModel.slice(0, -suffix.length);
      break;
    }
  }

  return {
    baseModel,
    isExpress,
    isPay,
    isOpenAIDirect,
    isOpenAISearch,
    isSearch,
    isNoThinking,
    isMaxThinking,
    is2kImage,
    is4kImage,
  };
}

// ----- Safety Settings -----

const SAFETY_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
];

export function buildSafetySettings(): VertexSafetySetting[] {
  return SAFETY_CATEGORIES.map((category) => ({
    category,
    threshold: "BLOCK_NONE",
  }));
}

// ----- Generation Config -----

export function buildGenerationConfig(
  request: OpenAIRequest,
  modelInfo: ParsedModelInfo
): VertexGenerationConfig {
  const config: VertexGenerationConfig = {};

  if (request.temperature != null) config.temperature = request.temperature;
  const maxTokens = request.max_tokens ?? request.max_completion_tokens;
  if (maxTokens != null) config.maxOutputTokens = maxTokens;
  if (request.top_p != null) config.topP = request.top_p;
  if (request.top_k != null) config.topK = request.top_k;
  if (request.stop) config.stopSequences = request.stop;
  if (request.seed != null) config.seed = request.seed;
  if (request.n != null) config.candidateCount = request.n;

  // Thinking config for Gemini 2.5+
  const base = modelInfo.baseModel;
  const isThinkingModel =
    base.includes("gemini-2.5-") ||
    base.includes("gemini-3");
  const isGemini3Model = base.includes("gemini-3");
  const isLiteModel = base.includes("gemini-2.5-flash-lite");

  if (isThinkingModel) {
    config.thinkingConfig = { includeThoughts: true };

    if (isGemini3Model) {
      const effort = request.reasoning_effort as string | undefined;
      if (modelInfo.isNoThinking) {
        config.thinkingConfig.thinkingLevel = "LOW";
      } else if (modelInfo.isMaxThinking) {
        config.thinkingConfig.thinkingLevel = "HIGH";
      } else if (effort === "low") {
        config.thinkingConfig.thinkingLevel = "LOW";
      } else if (effort === "medium") {
        config.thinkingConfig.thinkingLevel = "MEDIUM";
      } else if (effort === "high") {
        config.thinkingConfig.thinkingLevel = "HIGH";
      } else if (effort === "none") {
        config.thinkingConfig.thinkingLevel = "MINIMAL";
      }
    } else if (isLiteModel && !modelInfo.isMaxThinking) {
      config.thinkingConfig.includeThoughts = false;
    } else if (modelInfo.isNoThinking) {
      const budget =
        base.includes("gemini-2.5-pro") || base.includes("gemini-3-pro")
          ? 128
          : 0;
      config.thinkingConfig.thinkingBudget = budget;
      if (budget === 0) config.thinkingConfig.includeThoughts = false;
    } else if (modelInfo.isMaxThinking) {
      const budget =
        base.includes("gemini-2.5-pro") || base.includes("gemini-3-pro")
          ? 32768
          : 24576;
      config.thinkingConfig.thinkingBudget = budget;
      config.thinkingConfig.includeThoughts = true;
    }
  }

  // Image generation config
  if (modelInfo.is2kImage) {
    config.responseModalities = ["TEXT", "IMAGE"];
    config.imageConfig = { imageSize: "2K" };
  } else if (modelInfo.is4kImage) {
    config.responseModalities = ["TEXT", "IMAGE"];
    config.imageConfig = { imageSize: "4K" };
  }

  return config;
}

// ----- Message Conversion -----

/**
 * Convert a single OpenAI message to Vertex AI content parts.
 */
function convertMessageParts(msg: OpenAIMessage): VertexPart[] {
  const parts: VertexPart[] = [];

  if (msg.content === null || msg.content === undefined) {
    return parts;
  }

  if (typeof msg.content === "string") {
    if (msg.content.length > 0) {
      parts.push({ text: msg.content });
    }
    return parts;
  }

  // Array of content parts
  for (const part of msg.content as OpenAIContentPart[]) {
    if (part.type === "text") {
      parts.push({ text: part.text });
    } else if (part.type === "image_url") {
      const url = part.image_url.url;
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          parts.push({
            inlineData: { mimeType: match[1], data: match[2] },
          });
        }
      } else if (url.length > 0) {
        parts.push({
          fileData: { fileUri: url },
        });
      }
    }
  }

  return parts;
}

/**
 * Convert OpenAI messages array to Vertex AI contents array.
 */
export function convertMessagesToVertex(
  messages: OpenAIMessage[]
): VertexContent[] {
  const contents: VertexContent[] = [];
  const pendingFunctionResponses: VertexPart[] = [];
  const toolCallNames = new Map<string, string>();

  function flushFunctionResponses() {
    if (pendingFunctionResponses.length > 0) {
      contents.push({
        role: "function",
        parts: [...pendingFunctionResponses],
      });
      pendingFunctionResponses.length = 0;
    }
  }

  for (const msg of messages) {
    // Handle tool (function response) messages
    if (msg.role === "tool") {
      const toolCallId = msg.tool_call_id || "";
      const funcName = msg.name || toolCallNames.get(toolCallId) || "function_response";
      let responseData: Record<string, unknown>;

      try {
        const content =
          typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        if (content && (content.trim().startsWith("{") || content.trim().startsWith("["))) {
          responseData = JSON.parse(content);
        } else {
          responseData = { result: content };
        }
      } catch {
        responseData = { result: String(msg.content) };
      }

      pendingFunctionResponses.push({
        functionResponse: {
          name: funcName,
          response: responseData,
          id: toolCallId || undefined,
        },
      });
      continue;
    }

    // Handle assistant messages with tool_calls
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      flushFunctionResponses();
      const parts: VertexPart[] = [];

      for (const tc of msg.tool_calls) {
        if (tc.id) {
          toolCallNames.set(tc.id, tc.function.name);
        }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          /* empty args */
        }

        parts.push({
          functionCall: {
            name: tc.function.name,
            args,
            id: tc.id || undefined,
          },
        });
      }

      // Also include text content if present
      if (typeof msg.content === "string" && msg.content.length > 0) {
        parts.push({ text: msg.content });
      }

      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    // Regular messages
    flushFunctionResponses();

    const parts = convertMessageParts(msg);
    if (parts.length === 0) continue;

    // Map roles
    let role: string;
    switch (msg.role) {
      case "system":
        role = "user";
        break;
      case "assistant":
        role = "model";
        break;
      default:
        role = "user";
    }

    contents.push({ role, parts });
  }

  flushFunctionResponses();

  if (contents.length === 0) {
    contents.push({
      role: "user",
      parts: [{ text: "Hello" }],
    });
  }

  return contents;
}

function extractSystemInstruction(messages: OpenAIMessage[]): { parts: VertexPart[] } | undefined {
  const parts: VertexPart[] = [];

  for (const msg of messages) {
    if (msg.role !== "system") continue;
    if (typeof msg.content === "string" && msg.content.length > 0) {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text.length > 0) {
          parts.push({ text: part.text });
        }
      }
    }
  }

  return parts.length > 0 ? { parts } : undefined;
}

/**
 * Build a native Vertex generateContent request body.
 * This path is required for Vertex AI Express API keys.
 */
export function buildVertexGenerateContentBody(
  request: OpenAIRequest,
  modelInfo: ParsedModelInfo
): VertexRequest {
  const nonSystemMessages = request.messages.filter((msg) => msg.role !== "system");
  const body: VertexRequest = {
    contents: convertMessagesToVertex(nonSystemMessages),
    generationConfig: buildGenerationConfig(request, modelInfo),
    safetySettings: buildSafetySettings(),
  };

  const systemInstruction = extractSystemInstruction(request.messages);
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const tools = [];
  const functionDeclarations = convertToolsToVertex(request.tools);
  if (functionDeclarations.length > 0) {
    tools.push({ functionDeclarations });
  }
  if (modelInfo.isSearch || modelInfo.isOpenAISearch) {
    tools.push({ googleSearch: {} });
  }
  if (tools.length > 0) body.tools = tools;

  const toolConfig = convertToolChoiceToVertex(request.tool_choice);
  if (toolConfig) body.toolConfig = toolConfig;

  return body;
}

/**
 * Build the complete request body for Vertex AI OpenAI-compatible endpoint.
 * This is used for the /chat/completions pass-through to Vertex's OpenAI endpoint.
 */
export function buildOpenAICompatibleBody(
  request: OpenAIRequest,
  modelInfo: ParsedModelInfo
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: `google/${modelInfo.baseModel}`,
    messages: request.messages,
    stream: request.stream ?? false,
  };

  // Pass through standard OpenAI params
  if (request.temperature != null) body.temperature = request.temperature;
  if (request.max_tokens != null) body.max_tokens = request.max_tokens;
  if (request.max_completion_tokens != null) {
    body.max_completion_tokens = request.max_completion_tokens;
  }
  if (request.top_p != null) body.top_p = request.top_p;
  if (request.stop) body.stop = request.stop;
  if (request.seed != null) body.seed = request.seed;
  if (request.n != null) body.n = request.n;
  if (request.frequency_penalty != null) {
    body.frequency_penalty = request.frequency_penalty;
  }
  if (request.presence_penalty != null) {
    body.presence_penalty = request.presence_penalty;
  }
  if (request.tools) body.tools = request.tools;
  if (request.tool_choice) body.tool_choice = request.tool_choice;

  // Add reasoning_effort if valid
  if (
    request.reasoning_effort &&
    ["none", "low", "medium", "high"].includes(request.reasoning_effort as string)
  ) {
    body.reasoning_effort = request.reasoning_effort;
  }

  // Google-specific extra body for thinking/safety
  const thinkingTag = "vertex_think_tag";
  const safetySettings = buildSafetySettings().map((s) => ({
    category: s.category,
    threshold: s.threshold,
  }));

  const google: Record<string, unknown> = {
    safety_settings: safetySettings,
  };

  // Adjust thinking based on model flags
  const base = modelInfo.baseModel;
  const isThinkingModel = base.includes("gemini-2.5-") || base.includes("gemini-3");
  const isGemini3Model = base.includes("gemini-3");
  const isLiteModel = base.includes("gemini-2.5-flash-lite");

  if (isThinkingModel) {
    google.thought_tag_marker = thinkingTag;

    if (isGemini3Model) {
      if (modelInfo.isNoThinking && !body.reasoning_effort) {
        body.reasoning_effort = "low";
      } else if (modelInfo.isMaxThinking && !body.reasoning_effort) {
        body.reasoning_effort = "high";
      }
      google.thinking_config = { include_thoughts: true };
    } else if (isLiteModel && !modelInfo.isMaxThinking) {
      google.thinking_config = { include_thoughts: false };
    } else if (modelInfo.isNoThinking) {
      const budget = base.includes("gemini-2.5-pro") ? 128 : 0;
      google.thinking_config = {
        include_thoughts: budget > 0,
        thinking_budget: budget,
      };
    } else if (modelInfo.isMaxThinking) {
      const budget = base.includes("gemini-2.5-pro") ? 32768 : 24576;
      google.thinking_config = { include_thoughts: true, thinking_budget: budget };
    } else {
      google.thinking_config = { include_thoughts: true };
    }
  }

  // Image generation (for image models)
  if (base.includes("image")) {
    if (modelInfo.is2kImage) {
      google.response_modalities = ["TEXT", "IMAGE"];
      google.image_config = { image_size: "2K" };
    } else if (modelInfo.is4kImage) {
      google.response_modalities = ["TEXT", "IMAGE"];
      google.image_config = { image_size: "4K" };
    }
  }

  // Search tool
  if (modelInfo.isSearch || modelInfo.isOpenAISearch) {
    body.web_search_options = {};
  }

  body.extra_body = { google };

  return body;
}
