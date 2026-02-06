// Tool system
export {
  defineTool,
  isToolDefinition,
  walkToolTree,
  mergeToolTrees,
  type ApprovalMode,
  type ApprovalDecision,
  type ApprovalPresentation,
  type ApprovalRequest,
  type ReceiptDecision,
  type ReceiptStatus,
  type ToolCallReceipt,
  type ToolDefinition,
  type ToolTree,
  type DefineToolInput,
} from "./tools.js";

// Runner (sandbox execution)
export {
  createRunner,
  type Runner,
  type RunnerOptions,
  type RunResult,
} from "./runner.js";

// Typechecker
export {
  zodToTypeString,
  generateToolDeclarations,
  generatePromptGuidance,
  typecheckCode,
  type TypecheckResult,
} from "./typechecker.js";

// Agent loop
export {
  createAgent,
  type LanguageModel,
  type Message,
  type ToolCall,
  type GenerateResult,
  type AgentOptions,
  type AgentResult,
  type CodeRun,
} from "./agent.js";

// pi-ai adapter
export {
  createPiAiModel,
  type PiAiModelOptions,
} from "./pi-ai-adapter.js";

// Events
export type {
  TaskEvent,
  TaskStatusEvent,
  TaskCodeGeneratedEvent,
  TaskApprovalRequestEvent,
  TaskApprovalResolvedEvent,
  TaskToolResultEvent,
  TaskAgentMessageEvent,
  TaskErrorEvent,
  TaskCompletedEvent,
} from "./events.js";
