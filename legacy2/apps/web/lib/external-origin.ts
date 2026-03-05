import { webPublicEnvironment } from "./env/public";
import { webServerEnvironment } from "./env/server";

const normalizeOriginCandidate = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol =
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`;

  try {
    return new URL(withProtocol).origin;
  } catch {
    return null;
  }
};

export const configuredExternalOriginFromEnv = (): string | null => {
  const candidates = [
    webServerEnvironment.executorPublicOrigin,
    webPublicEnvironment.nextPublicAppOrigin,
    webServerEnvironment.vercelProjectProductionUrl,
    webServerEnvironment.vercelUrl,
  ];

  for (const candidate of candidates) {
    const origin = normalizeOriginCandidate(candidate);
    if (origin) {
      return origin;
    }
  }

  return null;
};
