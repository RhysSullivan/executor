import { z } from "zod";
import {
  fsAccessJsonProperties,
  fsAccessSchema,
  jsonValueJsonSchema,
  jsonValueSchema,
  toJsonSchema,
} from "./shared";

export const kvGetInputSchema = fsAccessSchema.extend({
  key: z.string(),
});

export const kvGetOutputSchema = z.object({
  instanceId: z.string(),
  key: z.string(),
  found: z.boolean(),
  value: jsonValueSchema.optional(),
});

export const kvSetInputSchema = fsAccessSchema.extend({
  key: z.string(),
  value: jsonValueSchema,
});

export const kvSetOutputSchema = z.object({
  instanceId: z.string(),
  key: z.string(),
  ok: z.boolean(),
});

export const kvListInputSchema = fsAccessSchema.extend({
  prefix: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const kvListOutputSchema = z.object({
  instanceId: z.string(),
  items: z.array(z.object({ key: z.string(), value: jsonValueSchema })),
  total: z.number(),
});

export const kvDeleteInputSchema = fsAccessSchema.extend({
  key: z.string(),
});

export const kvDeleteOutputSchema = z.object({
  instanceId: z.string(),
  key: z.string(),
  ok: z.boolean(),
});

export const kvIncrInputSchema = fsAccessSchema.extend({
  key: z.string(),
  by: z.coerce.number().optional(),
  initial: z.coerce.number().optional(),
});

export const kvIncrOutputSchema = z.object({
  instanceId: z.string(),
  key: z.string(),
  by: z.number(),
  previous: z.number(),
  value: z.number(),
});

export const kvGetInputJsonSchema = toJsonSchema(kvGetInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    key: { type: "string" },
  },
  required: ["key"],
  additionalProperties: false,
});

export const kvGetOutputJsonSchema = toJsonSchema(kvGetOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    key: { type: "string" },
    found: { type: "boolean" },
    value: jsonValueJsonSchema,
  },
  required: ["instanceId", "key", "found"],
  additionalProperties: false,
});

export const kvSetInputJsonSchema = toJsonSchema(kvSetInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    key: { type: "string" },
    value: jsonValueJsonSchema,
  },
  required: ["key", "value"],
  additionalProperties: false,
});

export const kvSetOutputJsonSchema = toJsonSchema(kvSetOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    key: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["instanceId", "key", "ok"],
  additionalProperties: false,
});

export const kvListInputJsonSchema = toJsonSchema(kvListInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    prefix: { type: "string" },
    limit: { type: "number" },
  },
  additionalProperties: false,
});

export const kvListOutputJsonSchema = toJsonSchema(kvListOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: jsonValueJsonSchema,
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
    total: { type: "number" },
  },
  required: ["instanceId", "items", "total"],
  additionalProperties: false,
});

export const kvDeleteInputJsonSchema = toJsonSchema(kvDeleteInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    key: { type: "string" },
  },
  required: ["key"],
  additionalProperties: false,
});

export const kvDeleteOutputJsonSchema = toJsonSchema(kvDeleteOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    key: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["instanceId", "key", "ok"],
  additionalProperties: false,
});

export const kvIncrInputJsonSchema = toJsonSchema(kvIncrInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    key: { type: "string" },
    by: { type: "number" },
    initial: { type: "number" },
  },
  required: ["key"],
  additionalProperties: false,
});

export const kvIncrOutputJsonSchema = toJsonSchema(kvIncrOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    key: { type: "string" },
    by: { type: "number" },
    previous: { type: "number" },
    value: { type: "number" },
  },
  required: ["instanceId", "key", "by", "previous", "value"],
  additionalProperties: false,
});
