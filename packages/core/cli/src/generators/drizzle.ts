// ---------------------------------------------------------------------------
// Drizzle schema generator — DBSchema → drizzle-orm TS source.
//
// Ported from better-auth (packages/cli/src/generators/drizzle.ts) under
// MIT. Adapted for executor:
//   - Reads our DBSchema shape (modelName optional, key = default)
//   - No auth-specific logic (uuid/serial id modes, usePlural, camelCase)
//   - Always emits text primary keys
//   - Dialect from ExecutorCliConfig, not from adapter.options.provider
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import type { DBSchema, DBFieldAttribute } from "@executor-js/storage-core";
import type { SchemaGenerator } from "./types.js";

type Dialect = "pg" | "sqlite" | "mysql";

const getModelName = (key: string, def: DBSchema[string]): string => def.modelName ?? key;

const getType = (name: string, field: DBFieldAttribute, dialect: Dialect): string => {
  if (field.references?.field === "id") {
    return `text('${name}')`;
  }

  const type = field.type;

  if (typeof type !== "string") {
    // Enum array — e.g. ["active", "inactive"]
    if (Array.isArray(type) && type.every((x) => typeof x === "string")) {
      return {
        sqlite: `text({ enum: [${type.map((x) => `'${x}'`).join(", ")}] })`,
        pg: `text('${name}', { enum: [${type.map((x) => `'${x}'`).join(", ")}] })`,
        mysql: `mysqlEnum([${type.map((x) => `'${x}'`).join(", ")}])`,
      }[dialect];
    }
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: generator rejects invalid schema input through the SchemaGenerator promise API
    throw new TypeError(`Invalid field type for field ${name}`);
  }

  const typeMap: Record<string, Record<Dialect, string>> = {
    string: {
      sqlite: `text('${name}')`,
      pg: `text('${name}')`,
      mysql: field.unique
        ? `varchar('${name}', { length: 255 })`
        : field.references
          ? `varchar('${name}', { length: 36 })`
          : field.sortable
            ? `varchar('${name}', { length: 255 })`
            : field.index
              ? `varchar('${name}', { length: 255 })`
              : `text('${name}')`,
    },
    boolean: {
      sqlite: `integer('${name}', { mode: 'boolean' })`,
      pg: `boolean('${name}')`,
      mysql: `boolean('${name}')`,
    },
    number: {
      sqlite: `integer('${name}')`,
      pg: field.bigint ? `bigint('${name}', { mode: 'number' })` : `integer('${name}')`,
      mysql: field.bigint ? `bigint('${name}', { mode: 'number' })` : `int('${name}')`,
    },
    date: {
      sqlite: `integer('${name}', { mode: 'timestamp_ms' })`,
      pg: `timestamp('${name}')`,
      mysql: `timestamp('${name}', { fsp: 3 })`,
    },
    "number[]": {
      sqlite: `text('${name}', { mode: "json" })`,
      pg: field.bigint
        ? `bigint('${name}', { mode: 'number' }).array()`
        : `integer('${name}').array()`,
      mysql: `text('${name}', { mode: 'json' })`,
    },
    "string[]": {
      sqlite: `text('${name}', { mode: "json" })`,
      pg: `text('${name}').array()`,
      mysql: `text('${name}', { mode: "json" })`,
    },
    json: {
      sqlite: `text('${name}', { mode: "json" })`,
      pg: `jsonb('${name}')`,
      mysql: `json('${name}', { mode: "json" })`,
    },
  };

  const dbTypeMap = typeMap[type];
  if (!dbTypeMap) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: generator rejects unsupported schema input through the SchemaGenerator promise API
    throw new Error(`Unsupported field type '${field.type}' for field '${name}'.`);
  }
  return dbTypeMap[dialect];
};

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export const generateDrizzleSchema: SchemaGenerator = async ({ schema, dialect, file }) => {
  const filePath = file || "./executor-schema.ts";
  const fileExist = existsSync(filePath);

  let code = generateImport({ dialect, schema });

  for (const [tableKey, tableDef] of Object.entries(schema)) {
    const modelName = getModelName(tableKey, tableDef);
    const fields = tableDef.fields;

    // Scoped tables get a composite `(scope_id, id)` primary key so two
    // tenants can register rows with the same user-facing id without
    // colliding on a globally-unique PK. Single-column PK stays for
    // unscoped tables (conformance fixtures, the blob store, etc.).
    const hasScopeId = Object.prototype.hasOwnProperty.call(fields, "scope_id");
    const id = hasScopeId ? `text('id').notNull()` : `text('id').primaryKey()`;

    type TableExtra =
      | { kind: "uniqueIndex" | "index"; name: string; on: string | readonly string[] }
      | { kind: "primaryKey"; columns: readonly string[] };
    const extras: TableExtra[] = [];

    const assignExtras = (items: TableExtra[]): string => {
      if (!items.length) return "";
      const lines: string[] = [`, (table) => [`];
      for (const item of items) {
        if (item.kind === "primaryKey") {
          const cols = item.columns.map((c) => `table.${c}`).join(", ");
          lines.push(`  primaryKey({ columns: [${cols}] }),`);
        } else {
          const cols = Array.isArray(item.on)
            ? item.on.map((c) => `table.${c}`).join(", ")
            : `table.${item.on}`;
          lines.push(`  ${item.kind}("${item.name}").on(${cols}),`);
        }
      }
      lines.push(`]`);
      return lines.join("\n");
    };

    if (hasScopeId) {
      extras.push({ kind: "primaryKey", columns: ["scope_id", "id"] });
    }

    const fieldLines = Object.entries(fields)
      .filter(([fieldName]) => fieldName !== "id")
      .map(([fieldName, attr]) => {
        const physical = attr.fieldName ?? fieldName;

        const isToolPolicyCompositeField =
          tableKey === "tool_policy" && (physical === "scope_id" || physical === "position");

        if (attr.index && !attr.unique && !isToolPolicyCompositeField) {
          extras.push({
            kind: "index",
            name: `${tableKey}_${physical}_idx`,
            on: physical,
          });
        } else if (attr.index && attr.unique) {
          extras.push({
            kind: "uniqueIndex",
            name: `${tableKey}_${physical}_uidx`,
            on: physical,
          });
        }

        let col = getType(physical, attr, dialect);

        if (attr.defaultValue !== null && typeof attr.defaultValue !== "undefined") {
          if (typeof attr.defaultValue === "function") {
            if (attr.type === "date" && attr.defaultValue.toString().includes("new Date()")) {
              if (dialect === "sqlite") {
                col += `.default(sql\`(cast(unixepoch('subsecond') * 1000 as integer))\`)`;
              } else {
                col += `.defaultNow()`;
              }
            }
          } else if (typeof attr.defaultValue === "string") {
            col += `.default("${attr.defaultValue}")`;
          } else {
            col += `.default(${attr.defaultValue})`;
          }
        }

        if (attr.onUpdate && attr.type === "date") {
          if (typeof attr.onUpdate === "function") {
            col += `.$onUpdate(${attr.onUpdate})`;
          }
        }

        return `${physical}: ${col}${attr.required !== false ? ".notNull()" : ""}${
          attr.unique ? ".unique()" : ""
        }${
          attr.references
            ? `.references(()=> ${attr.references.model}.${attr.references.field ?? "id"}, { onDelete: '${
                attr.references.onDelete || "cascade"
              }' })`
            : ""
        }`;
      })
      .join(",\n  ");

    if (tableKey === "tool_policy") {
      extras.push({
        kind: "index",
        name: "tool_policy_scope_id_position_idx",
        on: ["scope_id", "position"],
      });
    }

    const tableSchema = `export const ${tableKey} = ${dialect}Table("${modelName}", {
  id: ${id},
  ${fieldLines}
}${assignExtras(extras)});`;

    code += `\n${tableSchema}\n`;
  }

  // ---------------------------------------------------------------------------
  // Relations — scan FKs in both directions
  // ---------------------------------------------------------------------------

  let relationsString = "";
  for (const [tableKey, tableDef] of Object.entries(schema)) {
    const modelName = tableKey;

    type Relation = {
      key: string;
      model: string;
      type: "one" | "many";
      reference?: {
        field: string;
        references: string;
        fieldName: string;
      };
    };

    const oneRelations: Relation[] = [];
    const manyRelations: Relation[] = [];
    const manyRelationsSet = new Set<string>();

    // Find all FKs in THIS table → "one" relations
    for (const [fieldName, field] of Object.entries(tableDef.fields)) {
      if (!field.references) continue;
      const referencedModel = field.references.model;
      const physical = field.fieldName ?? fieldName;
      const fieldRef = `${tableKey}.${physical}`;
      const referenceRef = `${referencedModel}.${field.references.field || "id"}`;

      oneRelations.push({
        key: referencedModel,
        model: referencedModel,
        type: "one",
        reference: {
          field: fieldRef,
          references: referenceRef,
          fieldName,
        },
      });
    }

    // Find all OTHER tables that reference THIS table → "many" relations
    for (const [otherKey, otherDef] of Object.entries(schema)) {
      if (otherKey === tableKey) continue;
      const hasFK = Object.values(otherDef.fields).some(
        (field) => field.references?.model === tableKey,
      );
      if (!hasFK) continue;

      const relationKey = `${otherKey}s`;
      if (!manyRelationsSet.has(relationKey)) {
        manyRelationsSet.add(relationKey);
        manyRelations.push({
          key: relationKey,
          model: otherKey,
          type: "many",
        });
      }
    }

    // Detect duplicates
    const relationsByModel = new Map<string, Relation[]>();
    for (const rel of oneRelations) {
      if (!rel.reference) continue;
      const arr = relationsByModel.get(rel.key) ?? [];
      arr.push(rel);
      relationsByModel.set(rel.key, arr);
    }

    const duplicateRelations: Relation[] = [];
    const singleRelations: Relation[] = [];

    for (const [, rels] of relationsByModel.entries()) {
      if (rels.length > 1) {
        duplicateRelations.push(...rels);
      } else {
        singleRelations.push(rels[0]!);
      }
    }

    // Duplicate relations get field-specific exports
    for (const rel of duplicateRelations) {
      if (!rel.reference) continue;
      const relExportName = `${modelName}${rel.reference.fieldName.charAt(0).toUpperCase() + rel.reference.fieldName.slice(1)}Relations`;
      const block = `export const ${relExportName} = relations(${modelName}, ({ one }) => ({
  ${rel.key}: one(${rel.model}, {
    fields: [${rel.reference.field}],
    references: [${rel.reference.references}],
  })
}))`;
      relationsString += `\n${block}\n`;
    }

    // Combined single relations
    const hasOne = singleRelations.length > 0;
    const hasMany = manyRelations.length > 0;

    if (hasOne || hasMany) {
      const destructured = [hasOne ? "one" : "", hasMany ? "many" : ""].filter(Boolean).join(", ");

      const body = [
        ...singleRelations
          .filter((r) => r.reference)
          .map(
            (r) =>
              `  ${r.key}: one(${r.model}, {\n    fields: [${r.reference!.field}],\n    references: [${r.reference!.references}],\n  })`,
          ),
        ...manyRelations.map(({ key, model }) => `  ${key}: many(${model})`),
      ].join(",\n");

      const block = `export const ${modelName}Relations = relations(${modelName}, ({ ${destructured} }) => ({
${body}
}))`;
      relationsString += `\n${block}\n`;
    }
  }

  code += `\n${relationsString}`;

  return {
    code,
    fileName: filePath,
    overwrite: fileExist,
  };
};

// ---------------------------------------------------------------------------
// Import generation — only emit what's actually used
// ---------------------------------------------------------------------------

function generateImport({ dialect, schema }: { dialect: Dialect; schema: DBSchema }) {
  const rootImports: string[] = [];
  const coreImports: string[] = [];

  let hasBigint = false;
  let hasJson = false;
  let hasBoolean = false;
  let hasNumber = false;
  let hasDate = false;
  let hasIndex = false;
  let hasUniqueIndex = false;
  let hasReferences = false;
  let hasCompositePrimaryKey = false;

  for (const [tableKey, table] of Object.entries(schema)) {
    for (const field of Object.values(table.fields)) {
      if (field.bigint) hasBigint = true;
      if (field.type === "json") hasJson = true;
      if (field.type === "boolean") hasBoolean = true;
      if ((field.type === "number" && !field.bigint) || field.type === "number[]") {
        hasNumber = true;
      }
      if (field.type === "date") hasDate = true;
      if (field.index && !field.unique) hasIndex = true;
      if (field.index && field.unique) hasUniqueIndex = true;
      if (field.references) hasReferences = true;
    }
    // Scoped tables get a composite (scope_id, id) PK — see generator
    // body where `primaryKey({ columns: [...] })` is emitted.
    if (Object.prototype.hasOwnProperty.call(table.fields, "scope_id")) {
      hasCompositePrimaryKey = true;
    }
    // Keep the generator silent about tableKey in this pass — we only
    // need the existence check above. Referenced here to satisfy lint.
    void tableKey;
  }

  coreImports.push(`${dialect}Table`);
  coreImports.push("text");

  if (hasBoolean && dialect !== "sqlite") coreImports.push("boolean");
  if (hasDate) {
    if (dialect === "pg") coreImports.push("timestamp");
    // sqlite uses integer for timestamps, pg uses timestamp
  }
  if (hasNumber || dialect === "sqlite") {
    if (dialect === "pg") coreImports.push("integer");
    else if (dialect === "mysql") coreImports.push("int");
    else coreImports.push("integer");
  }
  if (hasBigint && dialect !== "sqlite") coreImports.push("bigint");
  if (hasJson) {
    if (dialect === "pg") coreImports.push("jsonb");
    else if (dialect === "mysql") coreImports.push("json");
    // sqlite uses text for JSON
  }
  if (hasIndex) coreImports.push("index");
  if (hasUniqueIndex) coreImports.push("uniqueIndex");
  if (hasCompositePrimaryKey) coreImports.push("primaryKey");

  // sqlite needs integer for boolean + date
  if (dialect === "sqlite" && (hasBoolean || hasDate)) {
    if (!coreImports.includes("integer")) coreImports.push("integer");
  }
  // sqlite needs real for number
  if (dialect === "sqlite" && hasNumber) {
    // better-auth uses integer for numbers on sqlite; we use real()
    // for floating-point fidelity.
  }

  // Has any timestamp with defaultNow function?
  const hasSqliteTimestamp =
    dialect === "sqlite" &&
    Object.values(schema).some((table) =>
      Object.values(table.fields).some(
        (field) =>
          field.type === "date" &&
          field.defaultValue &&
          typeof field.defaultValue === "function" &&
          field.defaultValue.toString().includes("new Date()"),
      ),
    );

  if (hasSqliteTimestamp) {
    rootImports.push("sql");
  }

  if (hasReferences || dialect === "mysql") {
    // mysql might need varchar for FK fields
  }

  // `relations` is only imported when the schema has any references that
  // produce relation blocks (see relationsString generation).
  if (hasReferences) rootImports.push("relations");

  const filteredCore = coreImports.map((x) => x.trim()).filter((x) => x !== "");

  // Deduplicate
  const uniqueCore = [...new Set(filteredCore)];
  const uniqueRoot = [...new Set(rootImports)];

  return `${uniqueRoot.length > 0 ? `import { ${uniqueRoot.join(", ")} } from "drizzle-orm";\n` : ""}import { ${uniqueCore.join(", ")} } from "drizzle-orm/${dialect}-core";\n`;
}
