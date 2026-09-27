/** Validate JSON shapes before converters dereference user-controlled fields. */
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

type ValidationError = { message: string; param: string };
const invalid = (param: string, expected: string): ValidationError => ({
  message: `Invalid '${param}': expected ${expected}.`, param,
});

function contentError(content: unknown, param: string, responses: boolean): ValidationError | null {
  if (content == null || typeof content === "string") return null;
  if (!Array.isArray(content)) return invalid(param, "a string or an array of content parts");
  for (const [i, part] of content.entries()) {
    const path = `${param}[${i}]`;
    if (!isObject(part)) return invalid(path, "a content object");
    if (part.type === "text" || (responses && (part.type === "input_text" || part.type === "output_text"))) {
      if (typeof part.text !== "string") return invalid(`${path}.text`, "a string");
    } else if (part.type === "image_url" || (responses && part.type === "input_image")) {
      const image = part.image_url;
      if (!(responses && typeof image === "string") && !(isObject(image) && typeof image.url === "string")) {
        return invalid(`${path}.image_url`, "an image URL");
      }
    } else if (responses && part.type === "refusal") {
      if (typeof part.refusal !== "string") return invalid(`${path}.refusal`, "a string");
    } else {
      return invalid(`${path}.type`, "a supported text or image content type");
    }
  }
  return null;
}

export function validateRequestShape(body: unknown, responses: boolean): ValidationError | null {
  if (!isObject(body)) return invalid("body", "a JSON object");
  if (body.stream != null && typeof body.stream !== "boolean") return invalid("stream", "a boolean");
  if (responses && body.instructions != null && typeof body.instructions !== "string") {
    return invalid("instructions", "a string");
  }
  const field = responses ? "input" : "messages";
  const items = body[field];
  if (items != null && !(responses && typeof items === "string")) {
    if (!Array.isArray(items)) return invalid(field, responses ? "a string or an array" : "an array");
    for (const [i, item] of items.entries()) {
      const path = `${field}[${i}]`;
      if (!isObject(item)) return invalid(path, "an object");
      if (responses && item.type === "reasoning") continue;
      if (responses && item.type === "function_call_output") continue;
      if (responses && item.type === "function_call") {
        if (typeof item.name !== "string" || typeof item.arguments !== "string") {
          return invalid(path, "a function call with string name and arguments");
        }
        continue;
      }
      if (typeof item.role !== "string" || !["system", "developer", "user", "assistant", ...(responses ? [] : ["tool"])].includes(item.role)) {
        return invalid(`${path}.role`, "a supported message role");
      }
      const error = contentError(item.content, `${path}.content`, responses);
      if (error) return error;
      if (item.tool_calls != null) {
        if (!Array.isArray(item.tool_calls)) return invalid(`${path}.tool_calls`, "an array");
        for (const call of item.tool_calls) {
          if (!isObject(call) || !isObject(call.function) || typeof call.function.name !== "string" || typeof call.function.arguments !== "string") {
            return invalid(`${path}.tool_calls`, "function calls with string name and arguments");
          }
        }
      }
    }
  }
  if (body.tools != null && (!Array.isArray(body.tools) || body.tools.some((tool) => !isObject(tool)))) {
    return invalid("tools", "an array of tool objects");
  }
  return null;
}
