import { Schema } from "effect";

export const ScopeId = Schema.String.pipe(Schema.brand("ScopeId"));
export type ScopeId = typeof ScopeId.Type;

export const ToolId = Schema.String.pipe(Schema.brand("ToolId"));
export type ToolId = typeof ToolId.Type;

export const SecretId = Schema.String.pipe(Schema.brand("SecretId"));
export type SecretId = typeof SecretId.Type;

export const PolicyId = Schema.String.pipe(Schema.brand("PolicyId"));
export type PolicyId = typeof PolicyId.Type;

export const ConnectionId = Schema.String.pipe(Schema.brand("ConnectionId"));
export type ConnectionId = typeof ConnectionId.Type;

export const ExecutionId = Schema.String.pipe(Schema.brand("ExecutionId"));
export type ExecutionId = typeof ExecutionId.Type;

export const ExecutionInteractionId = Schema.String.pipe(Schema.brand("ExecutionInteractionId"));
export type ExecutionInteractionId = typeof ExecutionInteractionId.Type;

export const ExecutionToolCallId = Schema.String.pipe(Schema.brand("ExecutionToolCallId"));
export type ExecutionToolCallId = typeof ExecutionToolCallId.Type;
