import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_EXECUTOR_LAUNCHD_LABEL,
  buildExecutorLaunchdPath,
  getDefaultExecutorLogPath,
  getDefaultLaunchAgentPath,
  renderLaunchAgentPlist,
} from "./plist";

describe("renderLaunchAgentPlist", () => {
  it("renders the core LaunchAgent keys", () => {
    const plist = renderLaunchAgentPlist({
      label: "sh.executor.daemon",
      program: "/usr/local/bin/executor",
      args: ["web", "--port", "4788"],
      stdoutPath: "/tmp/executor.log",
      stderrPath: "/tmp/executor.err.log",
    });

    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<string>sh.executor.daemon</string>");
    expect(plist).toContain("<key>ProgramArguments</key>");
    expect(plist).toContain("<string>/usr/local/bin/executor</string>");
    expect(plist).toContain("<string>web</string>");
    expect(plist).toContain("<string>--port</string>");
    expect(plist).toContain("<string>4788</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<string>/tmp/executor.log</string>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain("<string>/tmp/executor.err.log</string>");
  });

  it("renders environment variables when present", () => {
    const plist = renderLaunchAgentPlist({
      label: "sh.executor.daemon",
      program: "/usr/local/bin/executor",
      args: ["web"],
      stdoutPath: "/tmp/executor.log",
      stderrPath: "/tmp/executor.log",
      environment: {
        PATH: "/opt/homebrew/bin:/usr/bin",
        EXECUTOR_SCOPE_DIR: "/Users/saatvik/work",
      },
    });

    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
    expect(plist).toContain("<key>EXECUTOR_SCOPE_DIR</key>");
    expect(plist).toContain("<string>/Users/saatvik/work</string>");
  });

  it("omits environment variables when empty", () => {
    const plist = renderLaunchAgentPlist({
      label: "sh.executor.daemon",
      program: "/usr/local/bin/executor",
      args: ["web"],
      stdoutPath: "/tmp/executor.log",
      stderrPath: "/tmp/executor.log",
      environment: {},
    });

    expect(plist).not.toContain("<key>EnvironmentVariables</key>");
  });

  it("escapes XML special characters", () => {
    const plist = renderLaunchAgentPlist({
      label: `sh.executor.daemon&<>"'`,
      program: `/tmp/executor&<>"'`,
      args: [`web&<>"'`],
      stdoutPath: `/tmp/out&<>"'.log`,
      stderrPath: `/tmp/err&<>"'.log`,
      environment: {
        [`KEY&<>"'`]: `VALUE&<>"'`,
      },
    });

    expect(plist).toContain("sh.executor.daemon&amp;&lt;&gt;&quot;&apos;");
    expect(plist).toContain("/tmp/executor&amp;&lt;&gt;&quot;&apos;");
    expect(plist).toContain("web&amp;&lt;&gt;&quot;&apos;");
    expect(plist).toContain("KEY&amp;&lt;&gt;&quot;&apos;");
    expect(plist).toContain("VALUE&amp;&lt;&gt;&quot;&apos;");
  });
});

describe("path helpers", () => {
  it("builds a launchd-friendly PATH and dedupes entries", () => {
    const path = buildExecutorLaunchdPath("/usr/bin:/custom/bin:/opt/homebrew/bin");
    const parts = path.split(":");

    expect(parts).toContain(join(homedir(), ".bun", "bin"));
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/local/bin");
    expect(parts).toContain("/usr/bin");
    expect(parts).toContain("/bin");
    expect(parts).toContain("/custom/bin");
    expect(parts.filter((entry) => entry === "/usr/bin")).toHaveLength(1);
    expect(parts.filter((entry) => entry === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("returns executor default paths", () => {
    expect(DEFAULT_EXECUTOR_LAUNCHD_LABEL).toBe("sh.executor.daemon");
    expect(getDefaultLaunchAgentPath("sh.executor.daemon")).toBe(
      join(homedir(), "Library", "LaunchAgents", "sh.executor.daemon.plist"),
    );
    expect(getDefaultExecutorLogPath()).toBe(join(homedir(), ".executor", "daemon.log"));
  });
});
