import * as Schema from "effect/Schema";

export const SecretRefSchema = Schema.Struct({
  secretId: Schema.String,
});

export const CredentialSlotSchema = Schema.Literal("runtime", "import");

export const SourceCatalogKindSchema = Schema.Literal("imported");

export const SourceKindSchema = Schema.String;

export const SourceStatusSchema = Schema.Literal(
  "draft",
  "probing",
  "auth_required",
  "connected",
  "error",
);

export const SourceTransportSchema = Schema.Literal(
  "auto",
  "streamable-http",
  "sse",
  "stdio",
);

export const StringMapSchema = Schema.Record({
  key: Schema.String,
  value: Schema.String,
});

export const StringArraySchema = Schema.Array(Schema.String);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | ReadonlyArray<JsonValue>;

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(JsonValueSchema),
    Schema.Record({
      key: Schema.String,
      value: JsonValueSchema,
    }),
  )
).annotations({ identifier: "JsonValue" });

export const JsonObjectSchema = Schema.Record({
  key: Schema.String,
  value: JsonValueSchema,
}).annotations({ identifier: "JsonObject" });


export const SourceSchema = Schema.Struct({
  id: Schema.String,
  scopeId: Schema.String,
  name: Schema.String,
  kind: SourceKindSchema,
  status: SourceStatusSchema,
  enabled: Schema.Boolean,
  namespace: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});

export const StoredSourceRecordSchema = Schema.Struct({
  id: Schema.String,
});

export type SecretRef = typeof SecretRefSchema.Type;
export type CredentialSlot = typeof CredentialSlotSchema.Type;
export type SourceCatalogKind = typeof SourceCatalogKindSchema.Type;
export type SourceKind = typeof SourceKindSchema.Type;
export type SourceStatus = typeof SourceStatusSchema.Type;
export type SourceTransport = typeof SourceTransportSchema.Type;
export type StringMap = typeof StringMapSchema.Type;
export type StringArray = typeof StringArraySchema.Type;
export type Source = typeof SourceSchema.Type;
export type StoredSourceRecord = typeof StoredSourceRecordSchema.Type;
