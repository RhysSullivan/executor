import { randomBytes } from "node:crypto";
import Store from "electron-store";
import { DEFAULT_SERVER_SETTINGS, type DesktopServerSettings } from "../shared/server-settings";

interface PersistedShape {
  readonly server: DesktopServerSettings;
}

type SettingsStore = Store<PersistedShape>;

const generatePassword = (): string => randomBytes(24).toString("base64url");

const seedDefaults = (): DesktopServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  password: generatePassword(),
});

let store: SettingsStore | null = null;

const getStore = (): SettingsStore => {
  if (store) return store;

  // Create the store lazily so index.ts can set Electron's userData path
  // before electron-store resolves settings.json. Constructing this at module
  // import time can read/write settings under Electron's default app name and
  // make Desktop spawn with stale server settings such as the CLI port 4788.
  const next = new Store<PersistedShape>({
    name: "settings",
    defaults: { server: seedDefaults() },
  });

  // Backfill if an older settings.json predates the server section.
  if (!next.has("server")) {
    next.set("server", seedDefaults());
  }

  store = next;
  return next;
};

export const getServerSettings = (): DesktopServerSettings => getStore().get("server");

export const updateServerSettings = (
  patch: Partial<DesktopServerSettings>,
): DesktopServerSettings => {
  const current = getServerSettings();
  const next: DesktopServerSettings = {
    port: patch.port ?? current.port,
    requireAuth: patch.requireAuth ?? current.requireAuth,
    password: patch.password ?? current.password,
  };
  getStore().set("server", next);
  return next;
};

export const regeneratePassword = (): DesktopServerSettings => {
  const next = { ...getServerSettings(), password: generatePassword() };
  getStore().set("server", next);
  return next;
};
