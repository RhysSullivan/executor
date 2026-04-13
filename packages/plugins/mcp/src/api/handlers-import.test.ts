import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";

import { addGroup } from "@executor/api";
import { CoreHandlers, ExecutionEngineService, ExecutorService } from "@executor/api/server";
import type { McpPluginExtension, McpSourceConfig } from "../sdk/plugin";
import { McpExtensionService, McpHandlers } from "./handlers";
import { McpGroup } from "./group";

// ---------------------------------------------------------------------------
// Test extension — records addSource calls, returns canned results
// ---------------------------------------------------------------------------

interface RecordedCall {
  config: McpSourceConfig;
}

const makeCapturingExtension = (
  opts: {
    addSourceResult?: (
      config: McpSourceConfig,
    ) => Effect.Effect<{ toolCount: number; namespace: string }, Error>;
  } = {},
): { extension: McpPluginExtension; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];

  const extension: McpPluginExtension = {
    probeEndpoint: () => Effect.die(new Error("unused")),
    addSource: (config) => {
      calls.push({ config });
      if (opts.addSourceResult) return opts.addSourceResult(config);
      const namespace = config.namespace ?? config.name.toLowerCase().replace(/\s+/g, "_");
      return Effect.succeed({ toolCount: 3, namespace });
    },
    removeSource: () => Effect.die(new Error("unused")),
    refreshSource: () => Effect.die(new Error("unused")),
    startOAuth: () => Effect.die(new Error("unused")),
    completeOAuth: () => Effect.die(new Error("unused")),
    getSource: () => Effect.succeed(null),
    updateSource: () => Effect.die(new Error("unused")),
  };

  return { extension, calls };
};

// ---------------------------------------------------------------------------
// Handler setup
// ---------------------------------------------------------------------------

const Api = addGroup(McpGroup);
const fakeExecutor = {} as never;
const fakeExecutionEngine = {} as never;

const createHandler = (extension: McpPluginExtension) =>
  HttpApiBuilder.toWebHandler(
    HttpApiBuilder.api(Api).pipe(
      Layer.provide(CoreHandlers),
      Layer.provide(McpHandlers),
      Layer.provide(Layer.succeed(ExecutorService, fakeExecutor)),
      Layer.provide(Layer.succeed(ExecutionEngineService, fakeExecutionEngine)),
      Layer.provide(Layer.succeed(McpExtensionService, extension)),
      Layer.provideMerge(HttpServer.layerContext),
      Layer.provideMerge(HttpApiBuilder.Router.Live),
      Layer.provideMerge(HttpApiBuilder.Middleware.layer),
    ),
  );

const post = async (
  handler: ReturnType<typeof createHandler>["handler"],
  path: string,
  body: unknown,
) =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const get = async (handler: ReturnType<typeof createHandler>["handler"], path: string) =>
  handler(new Request(`http://localhost${path}`));

// ---------------------------------------------------------------------------
// importFromAgent — dry run (no addSource calls)
// ---------------------------------------------------------------------------

describe("POST /scopes/:scopeId/mcp/import — dry run", () => {
  it("returns parsed servers without importing when dryRun=true", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const content = JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx", args: ["-y", "fs"] },
          context7: { url: "https://mcp.context7.com/mcp" },
        },
      });

      const res = await post(web.handler, "/scopes/scope_1/mcp/import", {
        content,
        filename: "mcp.json",
        agentHint: "claude-code",
        dryRun: true,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        imported: unknown[];
        skipped: unknown[];
        dryRunParsed: unknown[];
      };

      expect(body.imported).toHaveLength(0);
      expect(body.skipped).toHaveLength(0);
      expect(body.dryRunParsed).toHaveLength(2);
    } finally {
      await web.dispose();
    }
  });

  it("dry run returns nothing for empty config", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const res = await post(web.handler, "/scopes/scope_1/mcp/import", {
        content: JSON.stringify({ mcpServers: {} }),
        filename: "mcp.json",
        agentHint: "claude-code",
        dryRun: true,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { dryRunParsed: unknown[] };
      expect(body.dryRunParsed).toHaveLength(0);
    } finally {
      await web.dispose();
    }
  });

  it("dry run auto-detects agent from opencode filename", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const content = JSON.stringify({
        mcp: {
          context7: { type: "remote", url: "https://mcp.context7.com/mcp" },
        },
      });

      const res = await post(web.handler, "/scopes/scope_1/mcp/import", {
        content,
        filename: "opencode.json",
        dryRun: true,
        // no agentHint — should auto-detect from filename
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { dryRunParsed: unknown[] };
      expect(body.dryRunParsed).toHaveLength(1);
    } finally {
      await web.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// importFromAgent — real import (addSource called)
// ---------------------------------------------------------------------------

describe("POST /scopes/:scopeId/mcp/import — real import", () => {
  it("imports stdio server and returns namespace + toolCount", async () => {
    const { extension, calls } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const content = JSON.stringify({
        mcpServers: {
          filesystem: { command: "npx", args: ["-y", "fs"], env: { HOME: "/tmp" } },
        },
      });

      const res = await post(web.handler, "/scopes/scope_1/mcp/import", {
        content,
        filename: "mcp.json",
        agentHint: "claude-code",
        dryRun: false,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        imported: { namespace: string; name: string; toolCount: number }[];
        skipped: unknown[];
      };

      expect(calls).toHaveLength(1);
      expect(calls[0]!.config.transport).toBe("stdio");
      if (calls[0]!.config.transport === "stdio") {
        expect(calls[0]!.config.command).toBe("npx");
        expect(calls[0]!.config.args).toEqual(["-y", "fs"]);
        expect(calls[0]!.config.env).toEqual({ HOME: "/tmp" });
      }

      expect(body.imported).toHaveLength(1);
      expect(body.imported[0]!.name).toBe("filesystem");
      expect(body.imported[0]!.toolCount).toBe(3);
      expect(body.skipped).toHaveLength(0);
    } finally {
      await web.dispose();
    }
  });

  it("imports remote server and preserves headers", async () => {
    const { extension, calls } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const content = JSON.stringify({
        mcpServers: {
          context7: {
            url: "https://mcp.context7.com/mcp",
            type: "http",
            headers: { "X-Api-Key": "secret" },
          },
        },
      });

      const res = await post(web.handler, "/scopes/scope_1/mcp/import", {
        content,
        filename: "mcp.json",
        agentHint: "claude-code",
        dryRun: false,
      });

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      if (calls[0]!.config.transport === "remote") {
        expect(calls[0]!.config.endpoint).toBe("https://mcp.context7.com/mcp");
        expect(calls[0]!.config.headers).toEqual({ "X-Api-Key": "secret" });
      }

      const body = (await res.json()) as { imported: unknown[] };
      expect(body.imported).toHaveLength(1);
    } finally {
      await web.dispose();
    }
  });

  it("imports multiple servers in one request", async () => {
    const { extension, calls } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const content = JSON.stringify({
        mcpServers: {
          alpha: { command: "alpha-server" },
          beta: { url: "https://beta.example.com/mcp" },
          gamma: { command: "gamma-server", args: ["--port", "9000"] },
        },
      });

      const res = await post(web.handler, "/scopes/scope_1/mcp/import", {
        content,
        filename: "mcp.json",
        agentHint: "claude-code",
        dryRun: false,
      });

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(3);
      const body = (await res.json()) as { imported: unknown[]; skipped: unknown[] };
      expect(body.imported).toHaveLength(3);
      expect(body.skipped).toHaveLength(0);
    } finally {
      await web.dispose();
    }
  });

  it("skips servers where addSource fails and continues with the rest", async () => {
    const { extension, calls } = makeCapturingExtension({
      addSourceResult: (config) => {
        if (config.name === "broken") {
          return Effect.fail(new Error("Connection refused"));
        }
        return Effect.succeed({ toolCount: 2, namespace: config.name });
      },
    });
    const web = createHandler(extension);

    try {
      const content = JSON.stringify({
        mcpServers: {
          working: { command: "good-server" },
          broken: { command: "bad-server" },
          alsogood: { command: "another-server" },
        },
      });

      const res = await post(web.handler, "/scopes/scope_1/mcp/import", {
        content,
        filename: "mcp.json",
        agentHint: "claude-code",
        dryRun: false,
      });

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(3);
      const body = (await res.json()) as {
        imported: { name: string }[];
        skipped: { name: string; reason: string }[];
      };

      expect(body.imported.map((s) => s.name)).toEqual(["working", "alsogood"]);
      expect(body.skipped).toHaveLength(1);
      expect(body.skipped[0]!.name).toBe("broken");
      expect(body.skipped[0]!.reason).toContain("Connection refused");
    } finally {
      await web.dispose();
    }
  });

  it("imports opencode config with array command", async () => {
    const { extension, calls } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const content = JSON.stringify({
        mcp: {
          myserver: {
            type: "local",
            command: ["node", "/path/to/server.js", "--debug"],
            enabled: true,
            environment: { NODE_ENV: "production" },
          },
        },
      });

      const res = await post(web.handler, "/scopes/scope_1/mcp/import", {
        content,
        filename: "opencode.json",
        agentHint: "opencode",
        dryRun: false,
      });

      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      if (calls[0]!.config.transport === "stdio") {
        expect(calls[0]!.config.command).toBe("node");
        expect(calls[0]!.config.args).toEqual(["/path/to/server.js", "--debug"]);
        expect(calls[0]!.config.env).toEqual({ NODE_ENV: "production" });
      }
    } finally {
      await web.dispose();
    }
  });

  it("returns 400 for malformed JSON content", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const res = await post(web.handler, "/scopes/scope_1/mcp/import", {
        content: "{ not valid json !!!",
        filename: "mcp.json",
        dryRun: false,
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain("Failed to parse config file");
    } finally {
      await web.dispose();
    }
  });

  it("uses suggestedNamespace from normalized server", async () => {
    const { extension, calls } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const content = JSON.stringify({
        mcpServers: {
          "My Server": { command: "my-server" },
        },
      });

      await post(web.handler, "/scopes/scope_1/mcp/import", {
        content,
        filename: "mcp.json",
        agentHint: "claude-code",
        dryRun: false,
      });

      expect(calls[0]!.config.namespace).toBe("my_server");
    } finally {
      await web.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// importFromAgent — agent-specific format handling
// ---------------------------------------------------------------------------

describe("POST /scopes/:scopeId/mcp/import — per-agent formats", () => {
  const importContent = async (
    handler: ReturnType<typeof createHandler>["handler"],
    agentHint: string,
    filename: string,
    content: string,
  ) => {
    const res = await post(handler, "/scopes/scope_1/mcp/import", {
      content,
      filename,
      agentHint,
      dryRun: true,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { dryRunParsed: unknown[] }).dryRunParsed;
  };

  it("handles vscode servers key", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);
    try {
      const content = JSON.stringify({
        servers: { myapi: { url: "https://api.example.com/mcp" } },
      });
      const parsed = await importContent(web.handler, "vscode", "mcp.json", content);
      expect(parsed).toHaveLength(1);
    } finally {
      await web.dispose();
    }
  });

  it("handles zed context_servers key", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);
    try {
      const content = JSON.stringify({
        context_servers: { myserver: { command: "node", args: [] } },
      });
      const parsed = await importContent(web.handler, "zed", "settings.json", content);
      expect(parsed).toHaveLength(1);
    } finally {
      await web.dispose();
    }
  });

  it("handles goose YAML", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);
    try {
      const content = `extensions:\n  srv:\n    type: streamable_http\n    uri: https://mcp.example.com/mcp\n`;
      const parsed = await importContent(web.handler, "goose", "config.yaml", content);
      expect(parsed).toHaveLength(1);
    } finally {
      await web.dispose();
    }
  });

  it("handles codex TOML", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);
    try {
      const content = `[mcp_servers.myserver]\ncommand = "npx"\nargs = ["-y", "pkg"]\n`;
      const parsed = await importContent(web.handler, "codex", "config.toml", content);
      expect(parsed).toHaveLength(1);
    } finally {
      await web.dispose();
    }
  });

  it("handles antigravity serverUrl key", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);
    try {
      const content = JSON.stringify({
        mcpServers: { myserver: { serverUrl: "https://api.example.com/mcp" } },
      });
      const parsed = await importContent(web.handler, "antigravity", "mcp_config.json", content);
      expect(parsed).toHaveLength(1);
    } finally {
      await web.dispose();
    }
  });

  it("handles codex http_headers via dry run", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);
    try {
      // Codex uses JSON key mcp_servers (TOML structure parsed same way)
      const content = JSON.stringify({
        mcp_servers: {
          myapi: {
            type: "http",
            url: "https://api.example.com/mcp",
            http_headers: { "X-Key": "val" },
          },
        },
      });
      const parsed = await importContent(web.handler, "codex", "config.json", content);
      expect(parsed).toHaveLength(1);
    } finally {
      await web.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// detectAgents endpoint
// ---------------------------------------------------------------------------

describe("GET /scopes/:scopeId/mcp/detect-agents", () => {
  it("returns an agents array", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const res = await get(web.handler, "/scopes/scope_1/mcp/detect-agents");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: unknown[] };
      expect(Array.isArray(body.agents)).toBe(true);
    } finally {
      await web.dispose();
    }
  });

  it("each detected agent has required fields", async () => {
    const { extension } = makeCapturingExtension();
    const web = createHandler(extension);

    try {
      const res = await get(web.handler, "/scopes/scope_1/mcp/detect-agents");
      const body = (await res.json()) as {
        agents: { agent: string; filePath: string; serverCount: number }[];
      };

      for (const agent of body.agents) {
        expect(typeof agent.agent).toBe("string");
        expect(typeof agent.filePath).toBe("string");
        expect(typeof agent.serverCount).toBe("number");
        expect(agent.serverCount).toBeGreaterThan(0);
      }
    } finally {
      await web.dispose();
    }
  });
});
