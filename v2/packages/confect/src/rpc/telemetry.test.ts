import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
	convexRequestIdHeader,
	extractParentSpanFromPayload,
	makeRpcTelemetryContext,
	makeRpcTransportHeaders,
	rpcTelemetryContextField,
	withOptionalRpcTelemetryContext,
	withRpcTelemetryContext,
} from "./telemetry";

describe("RPC telemetry context", () => {
	it("roundtrips span context through payload metadata", async () => {
		const payloadWithTelemetry = await Effect.runPromise(
			Effect.useSpan("rpc.client.test", { kind: "client" }, (span) =>
				Effect.succeed(
					withRpcTelemetryContext(
						{ message: "hello" },
						makeRpcTelemetryContext(span),
					),
				),
			),
		);

		const parentSpan = extractParentSpanFromPayload(payloadWithTelemetry);
		expect(Option.isSome(parentSpan)).toBe(true);

		if (Option.isSome(parentSpan)) {
			expect(parentSpan.value.traceId).toHaveLength(32);
			expect(parentSpan.value.spanId).toHaveLength(16);
		}
	});

	it("returns none when payload has no telemetry context", () => {
		const parentSpan = extractParentSpanFromPayload({ message: "hello" });
		expect(Option.isNone(parentSpan)).toBe(true);
	});

	it("returns none for malformed telemetry payload", () => {
		const parentSpan = extractParentSpanFromPayload({
			confectTelemetryContext: {
				traceparent: 123,
			},
		});

		expect(Option.isNone(parentSpan)).toBe(true);
	});

	it("creates transport headers with trace context and request id", async () => {
		const headers = await Effect.runPromise(
			Effect.useSpan("rpc.client.test", { kind: "client" }, (span) =>
				Effect.succeed(makeRpcTransportHeaders(span)),
			),
		);

		expect(headers.traceparent).toBeDefined();
		const requestId = headers[convexRequestIdHeader];
		expect(requestId).toBeDefined();
		if (requestId !== undefined) {
			expect(requestId.length).toBeGreaterThan(0);
		}
	});

	it("skips payload telemetry context when fallback is disabled", async () => {
		const payloadWithTelemetry = await Effect.runPromise(
			Effect.useSpan("rpc.client.test", { kind: "client" }, (span) =>
				Effect.succeed(
					withOptionalRpcTelemetryContext(
						"mutation",
						{ message: "hello" },
						span,
						false,
					),
				),
			),
		);

		expect(payloadWithTelemetry).toEqual({ message: "hello" });
	});

	it("adds payload telemetry context for mutations when fallback is enabled", async () => {
		const payloadWithTelemetry = await Effect.runPromise(
			Effect.useSpan("rpc.client.test", { kind: "client" }, (span) =>
				Effect.succeed(
					withOptionalRpcTelemetryContext(
						"mutation",
						{ message: "hello" },
						span,
						true,
					),
				),
			),
		);

		expect(payloadWithTelemetry).toMatchObject({ message: "hello" });
		expect(payloadWithTelemetry).toHaveProperty(rpcTelemetryContextField);
	});

	it("adds payload telemetry context for queries when fallback is enabled", async () => {
		const payloadWithTelemetry = await Effect.runPromise(
			Effect.useSpan("rpc.client.test", { kind: "client" }, (span) =>
				Effect.succeed(
					withOptionalRpcTelemetryContext("query", { page: 1 }, span, true),
				),
			),
		);

		expect(payloadWithTelemetry).toMatchObject({ page: 1 });
		expect(payloadWithTelemetry).toHaveProperty(rpcTelemetryContextField);
	});
});
