// ============================================================
// Project ID discovery via intentional API error
// ============================================================

/** Cache: Express API key → numeric project ID */
const projectIdCache = new Map<string, string>();

/**
 * Discover the GCP project ID associated with an Express API key by
 * triggering an intentional error against a non-existent model.
 * The error message contains the project number.
 */
export async function discoverProjectId(apiKey: string): Promise<string> {
  const cached = projectIdCache.get(apiKey);
  if (cached) return cached;

  const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-nonexistent-model-for-discovery:streamGenerateContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "test" }] }],
    }),
  });

  const text = await resp.text();

  // Try to extract project ID from error message
  // Pattern: "projects/39982734461/locations/..."
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // fall through to regex on raw text
  }

  let errorMessage = text;
  if (data) {
    // Handle both object and array response formats
    const obj = Array.isArray(data) ? data[0] : data;
    if (obj && typeof obj === "object" && "error" in obj) {
      const err = (obj as { error: { message?: string } }).error;
      errorMessage = err.message || text;
    }
  }

  const match = errorMessage.match(/projects\/(\d+)\/locations\//);
  if (match) {
    const projectId = match[1];
    projectIdCache.set(apiKey, projectId);
    console.log(`Discovered project ID: ${projectId}`);
    return projectId;
  }

  throw new Error(
    `Failed to discover project ID. Status: ${resp.status}, Response: ${text.slice(0, 500)}`
  );
}
