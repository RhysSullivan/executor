import { Schema } from "effect";

import { TimestampMsSchema } from "../../common";
import { OrganizationStatusSchema } from "../../enums";
import { AccountIdSchema, OrganizationIdSchema } from "../../ids";

export const OrganizationSchema = Schema.Struct({
  id: OrganizationIdSchema,
  slug: Schema.String,
  name: Schema.String,
  status: OrganizationStatusSchema,
  createdByAccountId: Schema.NullOr(AccountIdSchema),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
});

export type Organization = typeof OrganizationSchema.Type;
