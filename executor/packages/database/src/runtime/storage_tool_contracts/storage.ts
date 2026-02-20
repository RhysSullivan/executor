import { z } from "zod";
import {
  storageDurabilitySchema,
  storageProviderSchema,
  storageScopeSchema,
  storageStatusSchema,
  toJsonSchema,
} from "./shared";

export const storageInstanceSchema = z.object({
  id: z.string(),
  scopeType: storageScopeSchema,
  durability: storageDurabilitySchema,
  status: storageStatusSchema,
  provider: storageProviderSchema,
  backendKey: z.string(),
  organizationId: z.string(),
  workspaceId: z.string().optional(),
  accountId: z.string().optional(),
  createdByAccountId: z.string().optional(),
  purpose: z.string().optional(),
  sizeBytes: z.number().optional(),
  fileCount: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastSeenAt: z.number(),
  closedAt: z.number().optional(),
  expiresAt: z.number().optional(),
});

export const storageOpenInputSchema = z.object({
  instanceId: z.string().optional(),
  scopeType: storageScopeSchema.optional(),
  durability: storageDurabilitySchema.optional(),
  purpose: z.string().optional(),
  ttlHours: z.coerce.number().optional(),
});

export const storageOpenOutputSchema = z.object({
  instance: storageInstanceSchema,
});

export const storageListInputSchema = z.object({
  scopeType: storageScopeSchema.optional(),
  includeDeleted: z.boolean().optional(),
});

export const storageListOutputSchema = z.object({
  instances: z.array(storageInstanceSchema),
  total: z.number(),
});

export const storageCloseInputSchema = z.object({
  instanceId: z.string(),
});

export const storageCloseOutputSchema = z.object({
  instance: storageInstanceSchema.nullable(),
});

export const storageDeleteInputSchema = z.object({
  instanceId: z.string(),
});

export const storageDeleteOutputSchema = z.object({
  instance: storageInstanceSchema.nullable(),
});

export const storageOpenInputJsonSchema = toJsonSchema(storageOpenInputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    scopeType: { type: "string", enum: ["scratch", "account", "workspace", "organization"] },
    durability: { type: "string", enum: ["ephemeral", "durable"] },
    purpose: { type: "string" },
    ttlHours: { type: "number" },
  },
  additionalProperties: false,
});

export const storageOpenOutputJsonSchema = toJsonSchema(storageOpenOutputSchema, {
  type: "object",
  properties: {
    instance: { type: "object" },
  },
  required: ["instance"],
  additionalProperties: false,
});

export const storageListInputJsonSchema = toJsonSchema(storageListInputSchema, {
  type: "object",
  properties: {
    scopeType: { type: "string", enum: ["scratch", "account", "workspace", "organization"] },
    includeDeleted: { type: "boolean" },
  },
  additionalProperties: false,
});

export const storageListOutputJsonSchema = toJsonSchema(storageListOutputSchema, {
  type: "object",
  properties: {
    instances: { type: "array", items: { type: "object" } },
    total: { type: "number" },
  },
  required: ["instances", "total"],
  additionalProperties: false,
});

export const storageCloseInputJsonSchema = toJsonSchema(storageCloseInputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
  },
  required: ["instanceId"],
  additionalProperties: false,
});

export const storageCloseOutputJsonSchema = toJsonSchema(storageCloseOutputSchema, {
  type: "object",
  properties: {
    instance: {
      oneOf: [{ type: "object" }, { type: "null" }],
    },
  },
  required: ["instance"],
  additionalProperties: false,
});

export const storageDeleteInputJsonSchema = storageCloseInputJsonSchema;
export const storageDeleteOutputJsonSchema = storageCloseOutputJsonSchema;
