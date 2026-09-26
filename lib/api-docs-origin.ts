export function apiDocsBaseUrl(configured = process.env.APP_BASE_URL): string {
  if (!configured) return "http://localhost:3000";
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return "http://localhost:3000";
    }
    return url.origin;
  } catch {
    return "http://localhost:3000";
  }
}
