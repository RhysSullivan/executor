import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ---------------------------------------------------------------------------
  // executions: add triggerKind, triggerMetaJson, toolCallCount
  // ---------------------------------------------------------------------------

  yield* sql`ALTER TABLE executions ADD COLUMN trigger_kind TEXT`;
  yield* sql`ALTER TABLE executions ADD COLUMN trigger_meta_json TEXT`;
  yield* sql`
    ALTER TABLE executions ADD COLUMN tool_call_count INTEGER NOT NULL DEFAULT 0
  `;

  // ---------------------------------------------------------------------------
  // execution_tool_calls — one row per sandbox tools.x.y invocation
  // ---------------------------------------------------------------------------

  yield* sql`
    CREATE TABLE execution_tool_calls (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      status TEXT NOT NULL,
      tool_path TEXT NOT NULL,
      namespace TEXT NOT NULL,
      args_json TEXT,
      result_json TEXT,
      error_text TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER,
      FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX idx_execution_tool_calls_execution
    ON execution_tool_calls (execution_id, started_at)
  `;

  yield* sql`
    CREATE INDEX idx_execution_tool_calls_path
    ON execution_tool_calls (tool_path)
  `;
});
