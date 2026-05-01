// ============================================================
// GET /v1/models handler
// ============================================================

import type { Env, ModelsConfig } from "../types";
import { getExpressKeys, parseServiceAccountJsons } from "../config";
import defaultModels from "../models.json";

interface ModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

/**
 * Handle GET /v1/models — return list of available models with variants.
 */
export async function handleModels(env: Env): Promise<Response> {
  const hasExpress = getExpressKeys(env).length > 0;
  const hasSA = parseServiceAccountJsons(env.GOOGLE_CREDENTIALS_JSON).length > 0;

  // Load model config (use env override or built-in)
  let config: ModelsConfig;
  if (env.MODELS_CONFIG) {
    try {
      config = JSON.parse(env.MODELS_CONFIG);
    } catch {
      config = defaultModels;
    }
  } else {
    config = defaultModels;
  }

  const models: ModelEntry[] = [];
  const seen = new Set<string>();
  const now = Math.floor(Date.now() / 1000);

  function addWithVariants(
    baseId: string,
    prefix: string,
    includeOpenAIVariants: boolean
  ) {
    // Suffixes for each model
    const suffixes = [""];
    if (includeOpenAIVariants) {
      suffixes.push("-openai", "-openaisearch");
    }

    // Non-2.0 models get extra variants
    if (!baseId.startsWith("gemini-2.0")) {
      suffixes.push("-search");
    }

    // Thinking variants
    const hasThinking =
      (baseId.includes("gemini-2.5-flash") ||
        baseId === "gemini-2.5-pro" ||
        baseId.includes("gemini-3")) &&
      !baseId.includes("image");

    if (hasThinking) {
      suffixes.push("-nothinking", "-max");
    }

    // Image variants
    if (baseId.includes("image")) {
      suffixes.push("-2k", "-4k");
    }

    for (const suffix of suffixes) {
      const modelId = baseId + suffix;
      // Experimental models have no prefix
      const finalId = baseId.includes("-exp-")
        ? modelId
        : `${prefix}${modelId}`;

      if (!seen.has(finalId)) {
        seen.add(finalId);
        models.push({
          id: finalId,
          object: "model",
          created: now,
          owned_by: "google",
        });
      }
    }
  }

  // Express models
  if (hasExpress) {
    for (const m of config.vertex_express_models) {
      addWithVariants(m, "[EXPRESS] ", false);
    }
  }

  // SA models
  if (hasSA) {
    for (const m of config.vertex_models) {
      addWithVariants(m, "[PAY]", true);
    }
  }

  // Sort by id
  models.sort((a, b) => a.id.localeCompare(b.id));

  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: { "Content-Type": "application/json" },
  });
}
