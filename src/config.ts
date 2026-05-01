// ============================================================
// Configuration helpers — parse Env bindings into usable values
// ============================================================

import type { Env } from "./types";

/** Parse comma-separated Express API keys. */
export function getExpressKeys(env: Env): string[] {
  const raw = [env.VERTEX_EXPRESS_API_KEY, env.VERTEX_API_KEY]
    .filter(Boolean)
    .join(",");
  if (!raw) return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Parse one or more Service Account JSON objects from a string. */
export function parseServiceAccountJsons(
  raw: string | undefined
): Record<string, unknown>[] {
  if (!raw) return [];
  const results: Record<string, unknown>[] = [];
  let nesting = 0;
  let start = -1;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") {
      if (nesting === 0) start = i;
      nesting++;
    } else if (ch === "}") {
      nesting--;
      if (nesting === 0 && start !== -1) {
        try {
          const obj = JSON.parse(raw.slice(start, i + 1));
          if (obj.type && obj.project_id && obj.private_key && obj.client_email) {
            results.push(obj);
          }
        } catch {
          // skip malformed JSON
        }
        start = -1;
      }
    }
  }
  return results;
}

/** Get GCP location, defaulting to "global". */
export function getLocation(env: Env): string {
  return env.GCP_LOCATION || "global";
}
