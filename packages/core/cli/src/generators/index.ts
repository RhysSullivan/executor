import { generateDrizzleSchema } from "./drizzle.js";
import type { SchemaGenerator } from "./types.js";

export type { SchemaGenerator, SchemaGeneratorResult } from "./types.js";

const generators: Record<string, SchemaGenerator> = {
  drizzle: generateDrizzleSchema,
};

export const generateSchema = (adapter: string, ...args: Parameters<SchemaGenerator>) => {
  const generator = generators[adapter];
  if (!generator) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: synchronous CLI generator registry rejects unsupported adapter names
    throw new Error(
      `Generator "${adapter}" is not supported. Available: ${Object.keys(generators).join(", ")}`,
    );
  }
  return generator(...args);
};

export { generateDrizzleSchema };
