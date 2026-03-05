import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema";
import { Schema } from "effect";

import { policiesTable } from "../../persistence/schema";
import { TimestampMsSchema } from "../common";
import { AccountIdSchema, PolicyIdSchema, WorkspaceIdSchema } from "../ids";

export const PolicyResourceTypeSchema = Schema.Literal(
  "all_tools",
  "source",
  "namespace",
  "tool_path",
);

export const PolicyMatchTypeSchema = Schema.Literal("glob", "exact");
export const PolicyEffectSchema = Schema.Literal("allow", "deny");
export const PolicyApprovalModeSchema = Schema.Literal("auto", "required");

export const ArgumentConditionOperatorSchema = Schema.Literal(
  "equals",
  "contains",
  "starts_with",
  "not_equals",
);

export const PolicyArgumentConditionSchema = Schema.Struct({
  key: Schema.String,
  operator: ArgumentConditionOperatorSchema,
  value: Schema.String,
});

const policySchemaOverrides = {
  id: PolicyIdSchema,
  workspaceId: WorkspaceIdSchema,
  targetAccountId: Schema.NullOr(AccountIdSchema),
  clientId: Schema.NullOr(Schema.String),
  resourceType: PolicyResourceTypeSchema,
  matchType: PolicyMatchTypeSchema,
  effect: PolicyEffectSchema,
  approvalMode: PolicyApprovalModeSchema,
  argumentConditionsJson: Schema.NullOr(Schema.String),
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
} as const;

export const PolicySchema = createSelectSchema(policiesTable, policySchemaOverrides);

export const PolicyInsertSchema = createInsertSchema(
  policiesTable,
  policySchemaOverrides,
);

export const PolicyUpdateSchema = createUpdateSchema(
  policiesTable,
  policySchemaOverrides,
);

export type PolicyResourceType = typeof PolicyResourceTypeSchema.Type;
export type PolicyMatchType = typeof PolicyMatchTypeSchema.Type;
export type PolicyEffect = typeof PolicyEffectSchema.Type;
export type PolicyApprovalMode = typeof PolicyApprovalModeSchema.Type;
export type ArgumentConditionOperator =
  typeof ArgumentConditionOperatorSchema.Type;
export type PolicyArgumentCondition = typeof PolicyArgumentConditionSchema.Type;
export type Policy = typeof PolicySchema.Type;
