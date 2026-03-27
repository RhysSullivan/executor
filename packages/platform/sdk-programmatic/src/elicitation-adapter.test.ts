import {
  describe,
  expect,
  it,
} from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createElicitationAdapter } from "./elicitation-adapter";
import type {
  ToolElicitationRequest,
} from "@executor/codemode-core";

const makeToolApprovalRequest = (
  overrides?: Partial<ToolElicitationRequest>,
): ToolElicitationRequest => ({
  interactionId: "test-interaction-1",
  path: "source.github.issues.create" as any,
  sourceKey: "source.github",
  args: { title: "test" },
  elicitation: {
    mode: "form",
    message: "Allow tool call: source.github.issues.create?",
    requestedSchema: {
      type: "object",
      properties: { approve: { type: "boolean" } },
    },
  },
  context: {
    interactionPurpose: "tool_execution_gate",
    interactionReason: "Approval required by policy p1",
    invocationDescriptor: {
      operationKind: "write",
      sourceId: "src_github",
      sourceName: "GitHub",
      approvalLabel: "Create Issue",
    },
  },
  ...overrides,
});

const makeUrlRequest = (): ToolElicitationRequest => ({
  interactionId: "test-url-1",
  path: "executor.sources.add" as any,
  sourceKey: "source.slack",
  args: {},
  elicitation: {
    mode: "url",
    message: "Authorize Slack access",
    url: "https://slack.com/oauth/authorize?client_id=123",
    elicitationId: "url-1",
  },
  context: {},
});

const makeFormRequest = (): ToolElicitationRequest => ({
  interactionId: "test-form-1",
  path: "executor.sources.add" as any,
  sourceKey: "source.custom",
  args: {},
  elicitation: {
    mode: "form",
    message: "Select credential",
    requestedSchema: {
      type: "object",
      properties: { token: { type: "string" } },
    },
  },
  context: {
    interactionPurpose: "credential_selection",
  },
});

describe("elicitation-adapter", () => {
  describe("tool approval routing", () => {
    it.effect("allow-all preset returns accept", () =>
      Effect.gen(function* () {
        const adapter = createElicitationAdapter({ onToolApproval: "allow-all" });
        const result = yield* adapter(makeToolApprovalRequest());
        expect(result.action).toBe("accept");
      }),
    );

    it.effect("deny-all preset returns decline", () =>
      Effect.gen(function* () {
        const adapter = createElicitationAdapter({ onToolApproval: "deny-all" });
        const result = yield* adapter(makeToolApprovalRequest());
        expect(result.action).toBe("decline");
      }),
    );

    it.effect("undefined onToolApproval defaults to allow", () =>
      Effect.gen(function* () {
        const adapter = createElicitationAdapter({});
        const result = yield* adapter(makeToolApprovalRequest());
        expect(result.action).toBe("accept");
      }),
    );

    it.effect("callback returning approved: true maps to accept", () =>
      Effect.gen(function* () {
        const adapter = createElicitationAdapter({
          onToolApproval: async (req) => {
            expect(req.toolPath).toBe("source.github.issues.create");
            expect(req.operationKind).toBe("write");
            expect(req.sourceName).toBe("GitHub");
            expect(req.approvalLabel).toBe("Create Issue");
            expect(req.reason).toBe("Approval required by policy p1");
            return { approved: true };
          },
        });
        const result = yield* adapter(makeToolApprovalRequest());
        expect(result.action).toBe("accept");
      }),
    );

    it.effect("callback returning approved: false maps to decline", () =>
      Effect.gen(function* () {
        const adapter = createElicitationAdapter({
          onToolApproval: () => ({ approved: false, reason: "nope" }),
        });
        const result = yield* adapter(makeToolApprovalRequest());
        expect(result.action).toBe("decline");
      }),
    );
  });

  describe("url interaction routing", () => {
    it.effect("url elicitation routes to onInteraction", () =>
      Effect.gen(function* () {
        const adapter = createElicitationAdapter({
          onInteraction: async (req) => {
            expect(req.kind).toBe("url");
            if (req.kind === "url") {
              expect(req.url).toContain("slack.com");
              expect(req.message).toBe("Authorize Slack access");
            }
            return { action: "accept" };
          },
        });
        const result = yield* adapter(makeUrlRequest());
        expect(result.action).toBe("accept");
      }),
    );

    it.effect("missing onInteraction for url fails with descriptive error", () =>
      Effect.gen(function* () {
        const adapter = createElicitationAdapter({});
        const result = yield* Effect.either(adapter(makeUrlRequest()));
        expect(result._tag).toBe("Left");
      }),
    );
  });

  describe("form interaction routing", () => {
    it.effect("non-tool-gate form routes to onInteraction", () =>
      Effect.gen(function* () {
        const adapter = createElicitationAdapter({
          onInteraction: async (req) => {
            expect(req.kind).toBe("form");
            if (req.kind === "form") {
              expect(req.message).toBe("Select credential");
            }
            return { action: "accept", content: { token: "abc" } };
          },
        });
        const result = yield* adapter(makeFormRequest());
        expect(result.action).toBe("accept");
        expect(result.content).toEqual({ token: "abc" });
      }),
    );
  });
});
