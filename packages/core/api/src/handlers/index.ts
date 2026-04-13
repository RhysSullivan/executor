import { Layer } from "effect";

import { ToolsHandlers } from "./tools";
import { SourcesHandlers } from "./sources";
import { SecretsHandlers } from "./secrets";
import { PoliciesHandlers } from "./policies";
import { ScopeHandlers } from "./scope";
import { ExecutionsHandlers } from "./executions";

export { ToolsHandlers } from "./tools";
export { SourcesHandlers } from "./sources";
export { SecretsHandlers } from "./secrets";
export { PoliciesHandlers } from "./policies";
export { ScopeHandlers } from "./scope";
export { ExecutionsHandlers } from "./executions";

export const CoreHandlers = Layer.mergeAll(
  ToolsHandlers,
  SourcesHandlers,
  SecretsHandlers,
  PoliciesHandlers,
  ScopeHandlers,
  ExecutionsHandlers,
);
