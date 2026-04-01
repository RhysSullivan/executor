// Re-export effect-atom essentials so consumers don't need direct deps
export {
  Atom,
  AtomHttpApi,
  Result,
  RegistryContext,
  RegistryProvider,
  useAtom,
  useAtomMount,
  useAtomRefresh,
  useAtomSet,
  useAtomSuspense,
  useAtomValue,
} from "@effect-atom/atom-react";

// Base URL management
export { getBaseUrl, setBaseUrl } from "./base-url";

// Typed API client
export { ExecutorApiClient } from "./client";

// Query & mutation atoms
export {
  toolsAtom,
  sourceToolsAtom,
  toolSchemaAtom,
  sourcesAtom,
  sourceAtom,
  secretsAtom,
  secretStatusAtom,
  invokeTool,
  setSecret,
  removeSecret,
  removeSource,
  refreshSource,
} from "./atoms";

// Provider
export { ExecutorProvider } from "./provider";

// Re-export commonly needed SDK types
export { ScopeId, ToolId } from "@executor/sdk";
export type { ScopeId as ScopeIdType, ToolId as ToolIdType } from "@executor/sdk";

// Plugin contracts
export type { SourcePlugin } from "./source-plugin";
