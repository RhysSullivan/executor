import type { ExecutionEngine } from "@executor/execution";

export const withExecutionUsageTracking = (
  organizationId: string,
  engine: ExecutionEngine,
  trackUsage: (organizationId: string) => void,
): ExecutionEngine => ({
  execute: async (code, options) => {
    const result = await engine.execute(code, options);
    trackUsage(organizationId);
    return result;
  },
  executeWithPause: async (code) => {
    const result = await engine.executeWithPause(code);
    trackUsage(organizationId);
    return result;
  },
  resume: async (executionId, response) => {
    const result = await engine.resume(executionId, response);
    if (result !== null) {
      trackUsage(organizationId);
    }
    return result;
  },
  getDescription: engine.getDescription,
});
