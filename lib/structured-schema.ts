const UNSUPPORTED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
]);

function visitSchema(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitSchema(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, child] of Object.entries(value)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`Unsupported structured schema keyword at ${path}.${key}`);
    }
    visitSchema(child, `${path}.${key}`);
  }
}

export function assertSupportedStructuredSchema(schema: unknown): void {
  visitSchema(schema, "$schema");
}
