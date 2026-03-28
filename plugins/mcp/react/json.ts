const parseJson = (label: string, text: string): unknown | null => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Invalid JSON.";
    throw new Error(`${label} is invalid: ${message}`);
  }
};

export const parseJsonStringMap = (
  label: string,
  text: string,
): Record<string, string> | null => {
  const parsed = parseJson(label, text);
  if (parsed === null) {
    return null;
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.every(([, value]) => typeof value === "string")) {
    throw new Error(`${label} must only contain string values.`);
  }

  return entries.length > 0
    ? Object.fromEntries(entries as Array<[string, string]>)
    : null;
};

export const parseJsonStringArray = (
  label: string,
  text: string,
): Array<string> | null => {
  const parsed = parseJson(label, text);
  if (parsed === null) {
    return null;
  }

  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
    throw new Error(`${label} must be a JSON array of strings.`);
  }

  const normalized = parsed
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return normalized.length > 0 ? normalized : null;
};
