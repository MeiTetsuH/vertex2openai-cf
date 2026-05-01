// ============================================================
// TypeScript Type Definitions for Vertex2OpenAI CF Worker
// ============================================================

// ----- Cloudflare Worker Environment Bindings -----

export interface Env {
  /** Required. API key to protect this adapter service. */
  API_KEY: string;
  /** Vertex AI Express API key(s). Comma-separated for multiple. */
  VERTEX_EXPRESS_API_KEY?: string;
  /** Alias for VERTEX_EXPRESS_API_KEY. */
  VERTEX_API_KEY?: string;
  /** Service Account JSON key content(s). Comma-separated for multiple. */
  GOOGLE_CREDENTIALS_JSON?: string;
  /** Explicit GCP Project ID. */
  GCP_PROJECT_ID?: string;
  /** GCP location/region. Defaults to "global". */
  GCP_LOCATION?: string;
  /** Custom model list JSON override. */
  MODELS_CONFIG?: string;
}

// ----- OpenAI-Compatible Request Types -----

export interface OpenAIImageUrl {
  url: string;
  detail?: string;
}

export interface OpenAIContentPartText {
  type: "text";
  text: string;
}

export interface OpenAIContentPartImage {
  type: "image_url";
  image_url: OpenAIImageUrl;
}

export type OpenAIContentPart = OpenAIContentPartText | OpenAIContentPartImage;

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  top_p?: number;
  top_k?: number;
  stream?: boolean;
  stop?: string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  n?: number;
  tools?: OpenAITool[];
  tool_choice?: string | { type: "function"; function: { name: string } };
  reasoning_effort?: string;
  [key: string]: unknown; // Allow extra fields
}

// ----- OpenAI-Compatible Response Types -----

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIResponseMessage {
  role: "assistant";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChoice {
  index: number;
  message: OpenAIResponseMessage;
  finish_reason: string;
}

export interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIStreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Partial<OpenAIToolCall>[];
}

export interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: string | null;
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIStreamChoice[];
  usage?: OpenAIUsage;
}

// ----- Vertex AI Types -----

export interface VertexPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string; // base64
  };
  fileData?: {
    mimeType?: string;
    fileUri: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    id?: string;
  };
  thought?: boolean;
  thoughtSignature?: string; // base64
}

export interface VertexContent {
  role: string;
  parts: VertexPart[];
}

export interface VertexSafetySetting {
  category: string;
  threshold: string;
}

export interface VertexThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: "LOW" | "MEDIUM" | "HIGH" | "MINIMAL";
}

export interface VertexGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  seed?: number;
  candidateCount?: number;
  thinkingConfig?: VertexThinkingConfig;
  responseModalities?: string[];
  imageConfig?: { imageSize: string };
}

export interface VertexFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface VertexToolConfig {
  functionCallingConfig?: {
    mode: string;
    allowedFunctionNames?: string[];
  };
}

export interface VertexRequest {
  contents: VertexContent[];
  generationConfig?: VertexGenerationConfig;
  systemInstruction?: {
    parts: VertexPart[];
  };
  safetySettings?: VertexSafetySetting[];
  tools?: Array<{
    functionDeclarations?: VertexFunctionDeclaration[];
    googleSearch?: Record<string, unknown>;
  }>;
  toolConfig?: VertexToolConfig;
}

export interface VertexCandidate {
  content: {
    role: string;
    parts: VertexPart[];
  };
  finishReason?: string;
  safetyRatings?: unknown[];
}

export interface VertexUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface VertexResponse {
  candidates?: VertexCandidate[];
  usageMetadata?: VertexUsageMetadata;
  modelVersion?: string;
}

// ----- Internal Types -----

export interface ParsedModelInfo {
  baseModel: string;
  isExpress: boolean;
  isPay: boolean;
  isOpenAIDirect: boolean;
  isOpenAISearch: boolean;
  isSearch: boolean;
  isNoThinking: boolean;
  isMaxThinking: boolean;
  is2kImage: boolean;
  is4kImage: boolean;
}

export interface CredentialInfo {
  type: "express" | "service_account";
  projectId: string;
  token: string;
}

export interface ModelsConfig {
  vertex_models: string[];
  vertex_express_models: string[];
}
