export function normalizeSourceEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return "";
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const withHttps = `https://${trimmed.replace(/^\/\//, "")}`;

  try {
    return new URL(withHttps).toString();
  } catch {
    return trimmed;
  }
}
