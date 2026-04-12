import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE executions (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      status TEXT NOT NULL,
      code TEXT NOT NULL,
      result_json TEXT,
      error_text TEXT,
      logs_json TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_executions_scope_created_at
    ON executions (scope_id, created_at DESC, id DESC)
  `;

  yield* sql`
    CREATE TABLE execution_interactions (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      purpose TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      response_json TEXT,
      response_private_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (execution_id) REFERENCES executions(id)
    )
  `;

  yield* sql`
    CREATE INDEX idx_execution_interactions_execution_status
    ON execution_interactions (execution_id, status)
  `;
});
