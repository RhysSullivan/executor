import { Schema } from "effect";

import { AccountIdSchema } from "../../ids";

export const PrincipalProviderSchema = Schema.Literal("local", "workos", "service");

export const PrincipalSchema = Schema.Struct({
  accountId: AccountIdSchema,
  provider: PrincipalProviderSchema,
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
});

export type PrincipalProvider = typeof PrincipalProviderSchema.Type;
export type Principal = typeof PrincipalSchema.Type;
