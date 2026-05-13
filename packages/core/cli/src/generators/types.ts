import type { DBSchema } from "@executor-js/storage-core";
import type { ExecutorDialect } from "@executor-js/sdk/core";

export interface SchemaGeneratorResult {
  code?: string;
  fileName: string;
  overwrite?: boolean;
}

export interface SchemaGeneratorOptions {
  schema: DBSchema;
  dialect: ExecutorDialect;
  file?: string;
}

export interface SchemaGenerator {
  (opts: SchemaGeneratorOptions): Promise<SchemaGeneratorResult>;
}
