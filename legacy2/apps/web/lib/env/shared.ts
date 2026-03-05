export const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

export const isTruthy = (value: string | undefined): boolean => {
  const normalized = trim(value)?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};
