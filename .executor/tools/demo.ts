import * as Schema from "effect/Schema";

const DemoInputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    enthusiasm: Schema.optional(Schema.Number),
  }),
);

const DemoOutputSchema = Schema.standardSchemaV1(
  Schema.Struct({
    tool: Schema.String,
    message: Schema.String,
    inputEcho: Schema.Struct({
      name: Schema.String,
      enthusiasm: Schema.Number,
    }),
  }),
);

export default {
  description: "Demo local tool loaded from .executor/tools/demo.ts",
  inputSchema: DemoInputSchema,
  outputSchema: DemoOutputSchema,
  execute: ({
    name,
    enthusiasm,
  }: {
    name?: string;
    enthusiasm?: number;
  }) => {
    const trimmedName = name?.trim();
    const safeName = trimmedName && trimmedName.length > 0 ? trimmedName : "world";
    const safeEnthusiasm = Math.max(1, Math.min(5, Math.round(enthusiasm ?? 1)));

    return {
      tool: "demo",
      message: `Hello, ${safeName}${"!".repeat(safeEnthusiasm)}`,
      inputEcho: {
        name: safeName,
        enthusiasm: safeEnthusiasm,
      },
    };
  },
};
