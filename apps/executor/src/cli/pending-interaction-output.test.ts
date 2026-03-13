import { describe, expect, it } from "@effect/vitest";
import type { ExecutionInteraction } from "@executor/control-plane";

import {
  buildPausedExecutionOutput,
  parseInteractionPayload,
} from "./pending-interaction-output";

const makeInteraction = (patch: Partial<ExecutionInteraction> = {}): ExecutionInteraction => ({
  id: "exec_123:tool_execution_gate:call_1" as never,
  executionId: "exec_123" as never,
  status: "pending",
  kind: "form",
  purpose: "tool_execution_gate",
  payloadJson: JSON.stringify({
    elicitation: {
      mode: "form",
      message: "Allow DELETE /v2/domains/{domain}/records/{recordId}?",
      requestedSchema: {
        type: "object",
        properties: {
          approve: {
            type: "boolean",
            description: "Whether to approve the tool call",
          },
        },
        required: ["approve"],
        additionalProperties: false,
      },
    },
  }),
  responseJson: null,
  responsePrivateJson: null,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe("pending-interaction-output", () => {
  it("parses requested schema from interaction payload", () => {
    const parsed = parseInteractionPayload(makeInteraction());

    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe("form");
    expect(parsed?.requestedSchema).toEqual({
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          description: "Whether to approve the tool call",
        },
      },
      required: ["approve"],
      additionalProperties: false,
    });
  });

  it("builds a structured paused execution instruction with full resume command", () => {
    const output = buildPausedExecutionOutput({
      executionId: "exec_123",
      interaction: makeInteraction(),
      baseUrl: "http://127.0.0.1:8788",
      shouldOpenUrls: false,
    });

    expect(output.resumeCommand).toBe(
      "executor resume --execution-id exec_123 --base-url http://127.0.0.1:8788 --no-open",
    );
    expect(output.interaction.requestedSchema).toEqual({
      type: "object",
      properties: {
        approve: {
          type: "boolean",
          description: "Whether to approve the tool call",
        },
      },
      required: ["approve"],
      additionalProperties: false,
    });
    expect(output.instruction).toContain("requires approval");
    expect(output.instruction).toContain("Allow DELETE /v2/domains/{domain}/records/{recordId}?");
    expect(output.instruction).toContain(output.resumeCommand);
    expect(output.instruction).toContain("interaction.requestedSchema");
  });

  it("describes URL interactions with the next command to run", () => {
    const output = buildPausedExecutionOutput({
      executionId: "exec_456",
      interaction: makeInteraction({
        id: "exec_456:source_connect_oauth2:call_1" as never,
        executionId: "exec_456" as never,
        kind: "url",
        purpose: "source_connect_oauth2",
        payloadJson: JSON.stringify({
          elicitation: {
            mode: "url",
            message: "Finish connecting Vercel",
            url: "https://vercel.com/oauth/start",
          },
        }),
      }),
      baseUrl: "http://127.0.0.1:8788",
      shouldOpenUrls: true,
    });

    expect(output.interaction.mode).toBe("url");
    expect(output.interaction.url).toBe("https://vercel.com/oauth/start");
    expect(output.instruction).toContain("https://vercel.com/oauth/start");
    expect(output.instruction).toContain(
      "executor resume --execution-id exec_456 --base-url http://127.0.0.1:8788",
    );
  });
});
