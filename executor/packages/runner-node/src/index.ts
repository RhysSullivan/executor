export type NodeRunnerStatus = "completed" | "failed" | "timed_out" | "denied";

export interface NodeRunnerResult {
  status: NodeRunnerStatus;
  stdout: string;
  stderr: string;
  error?: string;
  exitCode?: number;
}

export interface NodeRunner {
  run(taskId: string, code: string, timeoutMs: number): Promise<NodeRunnerResult>;
}
