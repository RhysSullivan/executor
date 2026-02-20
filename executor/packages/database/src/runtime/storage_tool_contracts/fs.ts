import { z } from "zod";
import { fsAccessJsonProperties, fsAccessSchema, toJsonSchema } from "./shared";

export const fsReadInputSchema = fsAccessSchema.extend({
  path: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

export const fsReadOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  content: z.string(),
  bytes: z.number(),
});

export const fsWriteInputSchema = fsAccessSchema.extend({
  path: z.string(),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

export const fsWriteOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  bytesWritten: z.number(),
});

export const fsReaddirInputSchema = fsAccessSchema.extend({
  path: z.string().optional(),
});

export const fsReaddirOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  entries: z.array(z.object({
    name: z.string(),
    type: z.enum(["file", "directory", "symlink", "unknown"]),
    size: z.number().optional(),
    mtime: z.number().optional(),
  })),
});

export const fsStatInputSchema = fsAccessSchema.extend({
  path: z.string(),
});

export const fsStatOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  exists: z.boolean(),
  type: z.enum(["file", "directory", "symlink", "unknown"]).optional(),
  size: z.number().optional(),
  mode: z.number().optional(),
  mtime: z.number().optional(),
  ctime: z.number().optional(),
});

export const fsMkdirInputSchema = fsAccessSchema.extend({
  path: z.string(),
});

export const fsMkdirOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  ok: z.boolean(),
});

export const fsRemoveInputSchema = fsAccessSchema.extend({
  path: z.string(),
  recursive: z.boolean().optional(),
  force: z.boolean().optional(),
});

export const fsRemoveOutputSchema = z.object({
  instanceId: z.string(),
  path: z.string(),
  ok: z.boolean(),
});

export const fsReadInputJsonSchema = toJsonSchema(fsReadInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
    encoding: { type: "string", enum: ["utf8", "base64"] },
  },
  required: ["path"],
  additionalProperties: false,
});

export const fsReadOutputJsonSchema = toJsonSchema(fsReadOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    encoding: { type: "string", enum: ["utf8", "base64"] },
    content: { type: "string" },
    bytes: { type: "number" },
  },
  required: ["instanceId", "path", "encoding", "content", "bytes"],
  additionalProperties: false,
});

export const fsWriteInputJsonSchema = toJsonSchema(fsWriteInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
    content: { type: "string" },
    encoding: { type: "string", enum: ["utf8", "base64"] },
  },
  required: ["path", "content"],
  additionalProperties: false,
});

export const fsWriteOutputJsonSchema = toJsonSchema(fsWriteOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    bytesWritten: { type: "number" },
  },
  required: ["instanceId", "path", "bytesWritten"],
  additionalProperties: false,
});

export const fsReaddirInputJsonSchema = toJsonSchema(fsReaddirInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
  },
  additionalProperties: false,
});

export const fsReaddirOutputJsonSchema = toJsonSchema(fsReaddirOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    entries: { type: "array", items: { type: "object" } },
  },
  required: ["instanceId", "path", "entries"],
  additionalProperties: false,
});

export const fsStatInputJsonSchema = toJsonSchema(fsStatInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
  },
  required: ["path"],
  additionalProperties: false,
});

export const fsStatOutputJsonSchema = toJsonSchema(fsStatOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    exists: { type: "boolean" },
    type: { type: "string", enum: ["file", "directory", "symlink", "unknown"] },
    size: { type: "number" },
    mode: { type: "number" },
    mtime: { type: "number" },
    ctime: { type: "number" },
  },
  required: ["instanceId", "path", "exists"],
  additionalProperties: false,
});

export const fsMkdirInputJsonSchema = toJsonSchema(fsMkdirInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
  },
  required: ["path"],
  additionalProperties: false,
});

export const fsMkdirOutputJsonSchema = toJsonSchema(fsMkdirOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["instanceId", "path", "ok"],
  additionalProperties: false,
});

export const fsRemoveInputJsonSchema = toJsonSchema(fsRemoveInputSchema, {
  type: "object",
  properties: {
    ...fsAccessJsonProperties(),
    path: { type: "string" },
    recursive: { type: "boolean" },
    force: { type: "boolean" },
  },
  required: ["path"],
  additionalProperties: false,
});

export const fsRemoveOutputJsonSchema = toJsonSchema(fsRemoveOutputSchema, {
  type: "object",
  properties: {
    instanceId: { type: "string" },
    path: { type: "string" },
    ok: { type: "boolean" },
  },
  required: ["instanceId", "path", "ok"],
  additionalProperties: false,
});
