import * as Schema from "effect/Schema";

export const McpExecutableBindingSchema = Schema.Struct({
  toolId: Schema.String,
  toolName: Schema.String,
});

export type McpExecutableBinding = typeof McpExecutableBindingSchema.Type;

export const mcpExecutableBindingFromProviderData = (input: {
  toolId: string;
  toolName: string;
}): McpExecutableBinding => ({
  toolId: input.toolId,
  toolName: input.toolName,
});
