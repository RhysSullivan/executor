import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePGlite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import postgres from "postgres";

import { drizzleSchema, type DrizzleTables } from "./schema";

export type SqlBackend = "pglite" | "postgres";

export type CreateSqlRuntimeOptions = {
  databaseUrl?: string;
  localDataDir?: string;
  postgresApplicationName?: string;
};

export type SqlRuntime = {
  backend: SqlBackend;
  db: any;
  close: () => Promise<void>;
};

export type DrizzleContext = {
  db: any;
  tables: DrizzleTables;
};

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const isPostgresUrl = (value: string): boolean =>
  value.startsWith("postgres://") || value.startsWith("postgresql://");

const createPGliteRuntime = async (localDataDir: string): Promise<SqlRuntime> => {
  const normalized = trim(localDataDir) ?? ".executor-v3/control-plane-pgdata";

  let client: PGlite;
  if (normalized === ":memory:") {
    client = new PGlite();
  } else {
    const resolvedDataDir = path.resolve(normalized);
    if (!existsSync(resolvedDataDir)) {
      await mkdir(resolvedDataDir, { recursive: true });
    }
    client = new PGlite(resolvedDataDir);
  }

  const db = drizzlePGlite({ client, schema: drizzleSchema });

  return {
    backend: "pglite",
    db,
    close: async () => {
      await client.close();
    },
  };
};

const createPostgresRuntime = async (
  databaseUrl: string,
  applicationName: string | undefined,
): Promise<SqlRuntime> => {
  const client = postgres(databaseUrl, {
    prepare: false,
    max: 10,
    ...(applicationName
      ? { connection: { application_name: applicationName } }
      : {}),
  });
  const db = drizzlePostgres({ client, schema: drizzleSchema });

  return {
    backend: "postgres",
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
};

const ddlStatements = [
  `
create table if not exists organizations (
  id text primary key,
  slug text not null,
  name text not null,
  status text not null,
  created_by_account_id text,
  created_at bigint not null,
  updated_at bigint not null,
  constraint organizations_status_check check (status in ('active', 'suspended', 'archived'))
);
`,
  "create unique index if not exists organizations_slug_idx on organizations (slug);",
  "create index if not exists organizations_updated_idx on organizations (updated_at, id);",
  `
create table if not exists organization_memberships (
  id text primary key,
  organization_id text not null,
  account_id text not null,
  role text not null,
  status text not null,
  billable boolean not null,
  invited_by_account_id text,
  joined_at bigint,
  created_at bigint not null,
  updated_at bigint not null,
  constraint organization_memberships_role_check check (role in ('viewer', 'editor', 'admin', 'owner')),
  constraint organization_memberships_status_check check (status in ('invited', 'active', 'suspended', 'removed'))
);
`,
  "create index if not exists organization_memberships_org_idx on organization_memberships (organization_id);",
  "create index if not exists organization_memberships_account_idx on organization_memberships (account_id);",
  "create unique index if not exists organization_memberships_org_account_idx on organization_memberships (organization_id, account_id);",
  `
create table if not exists workspaces (
  id text primary key,
  organization_id text not null,
  name text not null,
  created_by_account_id text,
  created_at bigint not null,
  updated_at bigint not null
);
`,
  "create index if not exists workspaces_org_idx on workspaces (organization_id);",
  "create unique index if not exists workspaces_org_name_idx on workspaces (organization_id, name);",
  `
create table if not exists sources (
  workspace_id text not null,
  source_id text not null,
  name text not null,
  kind text not null,
  endpoint text not null,
  status text not null,
  enabled boolean not null,
  config_json text not null,
  source_hash text,
  last_error text,
  created_at bigint not null,
  updated_at bigint not null,
  primary key (workspace_id, source_id),
  constraint sources_kind_check check (kind in ('mcp', 'openapi', 'graphql', 'internal')),
  constraint sources_status_check check (status in ('draft', 'probing', 'auth_required', 'connected', 'error'))
);
`,
  "create unique index if not exists sources_workspace_name_idx on sources (workspace_id, name);",
  `
create table if not exists policies (
  id text primary key,
  workspace_id text not null,
  target_account_id text,
  client_id text,
  resource_type text not null,
  resource_pattern text not null,
  match_type text not null,
  effect text not null,
  approval_mode text not null,
  argument_conditions_json text,
  priority bigint not null,
  enabled boolean not null,
  created_at bigint not null,
  updated_at bigint not null,
  constraint policies_resource_type_check check (resource_type in ('all_tools', 'source', 'namespace', 'tool_path')),
  constraint policies_match_type_check check (match_type in ('glob', 'exact')),
  constraint policies_effect_check check (effect in ('allow', 'deny')),
  constraint policies_approval_mode_check check (approval_mode in ('auto', 'required'))
);
`,
  "create index if not exists policies_workspace_idx on policies (workspace_id, updated_at, id);",
];

export const ensureSchema = async (db: any): Promise<void> => {
  for (const statement of ddlStatements) {
    await db.execute(sql.raw(statement));
  }
};

export const createSqlRuntime = async (
  options: CreateSqlRuntimeOptions,
): Promise<SqlRuntime> => {
  const databaseUrl = trim(options.databaseUrl);
  const runtime =
    databaseUrl && isPostgresUrl(databaseUrl)
      ? await createPostgresRuntime(databaseUrl, trim(options.postgresApplicationName))
      : await createPGliteRuntime(options.localDataDir ?? ".executor-v3/control-plane-pgdata");

  await ensureSchema(runtime.db);
  return runtime;
};

export const createDrizzleContext = (db: any): DrizzleContext => ({
  db,
  tables: drizzleSchema,
});
