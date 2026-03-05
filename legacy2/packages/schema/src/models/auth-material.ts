import { Schema } from "effect";

import { TimestampMsSchema } from "../common";
import { AuthConnectionIdSchema, AuthMaterialIdSchema } from "../ids";

export const AuthMaterialSchema = Schema.Struct({
  id: AuthMaterialIdSchema,
  connectionId: AuthConnectionIdSchema,
  backend: Schema.String,
  materialHandle: Schema.String,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type AuthMaterial = typeof AuthMaterialSchema.Type;
