import { generateDrizzleSchema } from "./drizzle.js";
import type { SchemaGenerator } from "./types.js";

export type { SchemaGenerator, SchemaGeneratorResult } from "./types.js";

const generators: Record<string, SchemaGenerator> = {
  drizzle: generateDrizzleSchema,
};

export const generateSchema = (
  adapter: string,
  ...args: Parameters<SchemaGenerator>
) => {
  const generator = generators[adapter];
  if (!generator) {
    throw new Error(
      `Generator "${adapter}" is not supported. Available: ${Object.keys(generators).join(", ")}`,
    );
  }
  return generator(...args);
};

export { generateDrizzleSchema };
