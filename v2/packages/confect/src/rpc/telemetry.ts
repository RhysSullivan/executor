import * as Headers from "@effect/platform/Headers";
import * as HttpTraceContext from "@effect/platform/HttpTraceContext";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

export const rpcTelemetryContextField = "confectTelemetryContext";
export const convexRequestIdHeader = "convex-request-id";

export type RpcClientKind = "query" | "mutation" | "action";

export interface RpcTelemetryContext {
	readonly traceparent: string;
	readonly b3?: string;
	readonly tracestate?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const toStringValue = (value: unknown): Option.Option<string> =>
	typeof value === "string" ? Option.some(value) : Option.none();

const getRecordValue = (
	record: Record<string, unknown>,
	key: string,
): Option.Option<string> =>
	Option.flatMap(Option.fromNullable(record[key]), toStringValue);

export const makeRpcTelemetryContext = (
	span: Tracer.Span,
): RpcTelemetryContext => {
	const headers = HttpTraceContext.toHeaders(span);
	const traceparent = headers.traceparent;
	const tracestate = headers.tracestate;

	if (traceparent === undefined) {
		return {
			traceparent: `00-${span.traceId}-${span.spanId}-${
				span.sampled ? "01" : "00"
			}`,
			tracestate,
		};
	}

	if (headers.b3 === undefined) {
		return { traceparent, tracestate };
	}

	return {
		traceparent,
		b3: headers.b3,
		tracestate,
	};
};

export const makeRpcTransportHeaders = (
	span: Tracer.Span,
): Readonly<Record<string, string>> => {
	const telemetryContext = makeRpcTelemetryContext(span);
	const headers: Record<string, string> = {
		traceparent: telemetryContext.traceparent,
		[convexRequestIdHeader]: `${span.traceId}-${span.spanId}`,
	};

	if (telemetryContext.b3 !== undefined) {
		headers.b3 = telemetryContext.b3;
	}

	if (telemetryContext.tracestate !== undefined) {
		headers.tracestate = telemetryContext.tracestate;
	}

	return headers;
};

export const withOptionalRpcTelemetryContext = (
	_kind: RpcClientKind,
	payload: unknown,
	span: Tracer.Span,
	enablePayloadFallback: boolean,
): unknown => {
	if (!enablePayloadFallback) {
		return payload;
	}

	return withRpcTelemetryContext(payload, makeRpcTelemetryContext(span));
};

export const withRpcTelemetryContext = (
	payload: unknown,
	telemetryContext: RpcTelemetryContext,
): unknown => {
	if (!isRecord(payload)) {
		return payload;
	}

	return {
		...payload,
		[rpcTelemetryContextField]: telemetryContext,
	};
};

export const extractParentSpanFromPayload = (
	payload: unknown,
): Option.Option<Tracer.ExternalSpan> => {
	if (!isRecord(payload)) {
		return Option.none();
	}

	const rawTelemetryContext = payload[rpcTelemetryContextField];
	if (!isRecord(rawTelemetryContext)) {
		return Option.none();
	}

	const traceparent = Option.getOrUndefined(
		getRecordValue(rawTelemetryContext, "traceparent"),
	);
	const b3 = Option.getOrUndefined(getRecordValue(rawTelemetryContext, "b3"));
	const tracestate = Option.getOrUndefined(
		getRecordValue(rawTelemetryContext, "tracestate"),
	);

	if (traceparent === undefined && b3 === undefined) {
		return Option.none();
	}

	return HttpTraceContext.fromHeaders(
		Headers.fromInput({
			traceparent,
			b3,
			tracestate,
		}),
	);
};
