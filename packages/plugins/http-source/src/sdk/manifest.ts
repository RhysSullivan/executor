import type { HttpCredentialManifestEntry, HttpRequestSourceConfig } from "./types";

export const deriveHttpCredentialManifest = (input: {
  readonly section: string;
  readonly config: HttpRequestSourceConfig | undefined;
}): readonly HttpCredentialManifestEntry[] => {
  const config = input.config;
  if (!config) return [];

  const entries: HttpCredentialManifestEntry[] = [];

  for (const [name, slot] of Object.entries(config.headers ?? {})) {
    entries.push({
      slotKey: slot.slotKey,
      label: slot.label ?? name,
      family: "http.header",
      required: slot.required ?? false,
      ...(slot.prefix ? { prefix: slot.prefix } : {}),
      placement: {
        section: input.section,
        name,
      },
    });
  }

  for (const [name, slot] of Object.entries(config.query ?? {})) {
    entries.push({
      slotKey: slot.slotKey,
      label: slot.label ?? name,
      family: "http.query",
      required: slot.required ?? false,
      ...(slot.prefix ? { prefix: slot.prefix } : {}),
      placement: {
        section: input.section,
        name,
      },
    });
  }

  if (config.oauth) {
    entries.push({
      slotKey: config.oauth.connectionSlot,
      label: "OAuth connection",
      family: "http.oauth",
      required: true,
      placement: {
        section: input.section,
        name: "oauth.connection",
      },
    });
    entries.push({
      slotKey: config.oauth.clientIdSlot,
      label: "OAuth client ID",
      family: "http.oauth",
      required: true,
      placement: {
        section: input.section,
        name: "oauth.clientId",
      },
    });
    if (config.oauth.clientSecretSlot) {
      entries.push({
        slotKey: config.oauth.clientSecretSlot,
        label: "OAuth client secret",
        family: "http.oauth",
        required: true,
        placement: {
          section: input.section,
          name: "oauth.clientSecret",
        },
      });
    }
  }

  return entries;
};
