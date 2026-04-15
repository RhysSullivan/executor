import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "node:path";

import { xdgDataHome } from "./index";

const ENV_KEYS = ["XDG_DATA_HOME", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME"] as const;

function stubPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function clearEnv() {
  for (const key of ENV_KEYS) vi.stubEnv(key, "");
}

describe("xdgDataHome", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    clearEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  test("prefers XDG_DATA_HOME when set on any platform", () => {
    vi.stubEnv("XDG_DATA_HOME", "/custom/xdg");
    stubPlatform("linux");
    expect(xdgDataHome()).toBe("/custom/xdg");
    stubPlatform("win32");
    expect(xdgDataHome()).toBe("/custom/xdg");
    stubPlatform("darwin");
    expect(xdgDataHome()).toBe("/custom/xdg");
  });

  test("ignores empty / whitespace-only XDG_DATA_HOME", () => {
    vi.stubEnv("XDG_DATA_HOME", "   ");
    vi.stubEnv("HOME", "/home/user");
    stubPlatform("linux");
    expect(xdgDataHome()).toBe(join("/home/user", ".local", "share"));
  });

  test("trims whitespace around XDG_DATA_HOME", () => {
    vi.stubEnv("XDG_DATA_HOME", "  /trimmed/xdg  ");
    stubPlatform("linux");
    expect(xdgDataHome()).toBe("/trimmed/xdg");
  });

  describe("on posix", () => {
    beforeEach(() => stubPlatform("linux"));

    test("falls back to $HOME/.local/share", () => {
      vi.stubEnv("HOME", "/home/user");
      expect(xdgDataHome()).toBe(join("/home/user", ".local", "share"));
    });

    test("defaults to ~/.local/share when HOME is unset", () => {
      expect(xdgDataHome()).toBe(join("~", ".local", "share"));
    });
  });

  describe("on windows", () => {
    beforeEach(() => stubPlatform("win32"));

    test("prefers LOCALAPPDATA", () => {
      vi.stubEnv("LOCALAPPDATA", "C:\\Users\\user\\AppData\\Local");
      vi.stubEnv("APPDATA", "C:\\Users\\user\\AppData\\Roaming");
      vi.stubEnv("USERPROFILE", "C:\\Users\\user");
      expect(xdgDataHome()).toBe("C:\\Users\\user\\AppData\\Local");
    });

    test("falls back to APPDATA when LOCALAPPDATA is unset", () => {
      vi.stubEnv("APPDATA", "C:\\Users\\user\\AppData\\Roaming");
      vi.stubEnv("USERPROFILE", "C:\\Users\\user");
      expect(xdgDataHome()).toBe("C:\\Users\\user\\AppData\\Roaming");
    });

    test("falls back to USERPROFILE\\AppData\\Local when both are unset", () => {
      vi.stubEnv("USERPROFILE", "C:\\Users\\user");
      // The helper uses node:path.join which normalizes separators to the
      // runtime platform, so on a POSIX test runner we can't assert the
      // exact separator — just that all three segments are present.
      const result = xdgDataHome();
      expect(result).toContain("C:");
      expect(result).toContain("Users");
      expect(result).toContain("user");
      expect(result).toContain("AppData");
      expect(result).toContain("Local");
    });

    test("defaults USERPROFILE to ~ when everything is unset", () => {
      const result = xdgDataHome();
      expect(result.startsWith("~")).toBe(true);
      expect(result).toContain("AppData");
      expect(result).toContain("Local");
    });
  });
});
