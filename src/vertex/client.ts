// ============================================================
// Vertex AI REST API client for Cloudflare Workers
// ============================================================

import type { Env } from "../types";
import { getExpressKeys, parseServiceAccountJsons, getLocation } from "../config";
import { KeyManager } from "./key-manager";
import { getServiceAccountToken } from "./auth";

export interface VertexClientOptions {
  authType: "express" | "service_account";
  projectId?: string;
  location: string;
  authHeader?: string;
  apiKey?: string;
}

export type CredentialPreference = "express" | "service_account";

const expressManagers = new Map<string, KeyManager>();

function getExpressKey(env: Env): string | null {
  const raw = [env.VERTEX_EXPRESS_API_KEY, env.VERTEX_API_KEY]
    .filter(Boolean)
    .join(",");
  const expressKeys = getExpressKeys(env);
  if (!raw || expressKeys.length === 0) return null;

  let manager = expressManagers.get(raw);
  if (!manager) {
    manager = new KeyManager(expressKeys);
    expressManagers.set(raw, manager);
  }

  const keyTuple = manager.getKey();
  return keyTuple ? keyTuple[1] : null;
}

/**
 * Resolve credentials from Env and return options needed to call Vertex AI.
 * Priority: requested credential type, otherwise Express API Key > Service Account JSON.
 */
export async function resolveCredentials(
  env: Env,
  preference?: CredentialPreference
): Promise<VertexClientOptions> {
  const location = getLocation(env);

  if (preference !== "service_account") {
    const apiKey = getExpressKey(env);
    if (apiKey) {
      return {
        authType: "express",
        location,
        apiKey,
      };
    }
  }

  if (preference !== "express") {
    const saJsons = parseServiceAccountJsons(env.GOOGLE_CREDENTIALS_JSON);
    if (saJsons.length > 0) {
      const sa = saJsons[0] as {
        client_email: string;
        private_key: string;
        project_id: string;
      };
      const token = await getServiceAccountToken(sa);
      const projectId = env.GCP_PROJECT_ID || sa.project_id;
      return {
        authType: "service_account",
        projectId,
        location,
        authHeader: `Bearer ${token}`,
      };
    }
  }

  throw new Error(
    preference === "express"
      ? "No Vertex Express API key configured. Set VERTEX_EXPRESS_API_KEY."
      : preference === "service_account"
        ? "No Service Account JSON configured. Set GOOGLE_CREDENTIALS_JSON."
        : "No credentials configured. Set VERTEX_EXPRESS_API_KEY or GOOGLE_CREDENTIALS_JSON."
  );
}

/**
 * Build the Vertex AI OpenAI-compatible endpoint URL.
 */
export function buildOpenAIEndpointUrl(
  opts: VertexClientOptions,
  path: string
): string {
  if (opts.authType !== "service_account" || !opts.projectId) {
    throw new Error("OpenAI-compatible endpoint requires Service Account credentials.");
  }

  const host =
    opts.location === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${opts.location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${opts.projectId}/locations/${opts.location}/endpoints/openapi${path}`;
}

/**
 * Build the official Vertex AI Express generateContent URL.
 */
export function buildExpressGenerateContentUrl(
  opts: VertexClientOptions,
  model: string,
  stream: boolean
): string {
  if (opts.authType !== "express" || !opts.apiKey) {
    throw new Error("Express generateContent endpoint requires an Express API key.");
  }

  const action = stream ? "streamGenerateContent" : "generateContent";
  const params = new URLSearchParams({ key: opts.apiKey });
  if (stream) params.set("alt", "sse");

  return `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodeURIComponent(
    model
  )}:${action}?${params.toString()}`;
}

/**
 * Build headers for a Vertex AI request.
 */
export function buildHeaders(opts: VertexClientOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.authHeader) {
    headers["Authorization"] = opts.authHeader;
  }
  return headers;
}
