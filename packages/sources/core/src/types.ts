import type {
  OnElicitation,
  ToolDescriptor as CatalogToolDescriptor,
} from "@executor/codemode-core";
import type { Capability, CatalogV1, Executable } from "@executor/ir/model";
import type {
  Source,
} from "./source-models";

export type SourceSyncInput = {
  source: Source;
};

export type SourceInvokeResult = {
  data: unknown;
  error: unknown;
  headers: Record<string, string>;
  status: number | null;
};

export type SourceInvokeInput = {
  source: Source;
  capability: Capability;
  executable: Executable;
  descriptor: CatalogToolDescriptor;
  catalog: CatalogV1;
  args: unknown;
  onElicitation?: OnElicitation;
  context?: Record<string, unknown>;
};
