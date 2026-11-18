/**
 * Deterministic UTF-16 code-unit ordering, independent of locale and ICU data.
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Serializes JSON data with object keys recursively sorted by `compareText`,
 * array order preserved, two-space indentation, and a trailing newline.
 *
 * Serialization is done here rather than by `JSON.stringify` because
 * JavaScript objects enumerate integer-like keys numerically before all others.
 */
export function canonicalJSON(value: unknown): string {
  return `${serialize(value, "", "$")}\n`;
}

function serialize(value: unknown, indent: string, path: string): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Non-finite number at ${path} has no JSON representation.`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error(`Value at ${path} of type ${typeof value} has no JSON representation.`);
  }

  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Array.from visits holes, which then fail as undefined instead of vanishing.
    const elements = Array.from(
      value as unknown[],
      (element, index) => `${inner}${serialize(element, inner, `${path}[${index}]`)}`,
    );
    return `[\n${elements.join(",\n")}\n${indent}]`;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Value at ${path} is not a plain JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${inner}${JSON.stringify(key)}: ${serialize(record[key], inner, `${path}.${key}`)}`);
  return members.length === 0 ? "{}" : `{\n${members.join(",\n")}\n${indent}}`;
}
