/* oxlint-disable executor/no-try-catch-or-throw, executor/no-json-parse -- boundary: out-of-band migration script over a raw postgres connection */
// ---------------------------------------------------------------------------
// One-off data migration: unwrap the retired {status, headers, data}
// transport envelope from persisted OpenAPI tool output schemas. The
// runtime now returns the upstream payload as `data` (with status/headers
// in the ToolResult `http` side channel), so persisted schemas must
// describe the payload only — otherwise describe.tool previews show an
// envelope that invocations no longer return. Run OUT-OF-BAND against the
// database BEFORE deploying the payload-first runtime:
//
//   bun run db:migrate-openapi-output:prod   # op run --env-file=.env.production
//   bun run db:migrate-openapi-output:dev    # against the local dev db
//
// Idempotent — payload-shaped rows don't match the envelope signature, so
// re-running plans zero updates. Pass --dry-run to print the plan without
// writing.
// ---------------------------------------------------------------------------

import postgres from "postgres";

interface EnvelopeSchema {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: {
    readonly status: unknown;
    readonly headers: unknown;
    readonly data: unknown;
  };
}

// Matches exactly what openApiTransportOutputSchema used to emit.
const isTransportEnvelope = (schema: unknown): schema is EnvelopeSchema => {
  if (typeof schema !== "object" || schema === null) return false;
  const s = schema as Record<string, unknown>;
  if (s.type !== "object" || s.additionalProperties !== false) return false;
  const required = s.required;
  if (!Array.isArray(required) || required.length !== 3) return false;
  if (!["status", "headers", "data"].every((key) => required.includes(key))) return false;
  const properties = s.properties;
  if (typeof properties !== "object" || properties === null) return false;
  const props = properties as Record<string, unknown>;
  return (
    JSON.stringify(props.status) === '{"type":"integer"}' &&
    JSON.stringify(props.headers) ===
      '{"type":"object","additionalProperties":{"type":"string"}}' &&
    "data" in props
  );
};

// The old producer filled `data: {}` when the operation declared no output
// schema; the new producer persists NULL for those.
const unwrappedSchema = (envelope: EnvelopeSchema): unknown => {
  const data = envelope.properties.data;
  if (typeof data === "object" && data !== null && Object.keys(data).length === 0) return null;
  return data;
};

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

// Direct (non-Hyperdrive) connection — PlanetScale requires TLS.
const sql = postgres(connectionString, { max: 1, prepare: false, ssl: "require" });

try {
  const rows = await sql<{ row_id: string; name: string; output_schema: unknown }[]>`
    SELECT row_id, name, output_schema FROM tool
    WHERE plugin_id = 'openapi' AND output_schema IS NOT NULL
  `;

  const updates = rows.flatMap((row) => {
    const schema =
      typeof row.output_schema === "string" ? JSON.parse(row.output_schema) : row.output_schema;
    if (!isTransportEnvelope(schema)) return [];
    return [{ rowId: row.row_id, name: row.name, outputSchema: unwrappedSchema(schema) }];
  });

  console.log(
    `${rows.length} openapi tool row(s) with output schemas, ${updates.length} to unwrap`,
  );

  if (dryRun) {
    for (const update of updates) {
      console.log(
        `  would unwrap ${update.rowId} (${update.name})${update.outputSchema === null ? " -> NULL" : ""}`,
      );
    }
  } else if (updates.length > 0) {
    await sql.begin(async (tx) => {
      for (const update of updates) {
        await tx`
          UPDATE tool
          SET output_schema = ${update.outputSchema === null ? null : tx.json(update.outputSchema as never)}
          WHERE row_id = ${update.rowId}
        `;
      }
    });
    console.log(`unwrapped ${updates.length} row(s)`);
  }
} finally {
  await sql.end();
}
