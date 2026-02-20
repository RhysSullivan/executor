import { v } from "convex/values";
import { literals } from "convex-helpers/validators";
import {
  ACCOUNT_PROVIDERS,
  ACCOUNT_STATUSES,
  APPROVAL_STATUSES,
  ARGUMENT_CONDITION_OPERATORS,
  BILLING_SUBSCRIPTION_STATUSES,
  COMPLETED_TASK_STATUSES,
  CREDENTIAL_PROVIDERS,
  CREDENTIAL_SCOPE_TYPES,
  INVITE_STATUSES,
  ORGANIZATION_MEMBER_STATUSES,
  ORGANIZATION_ROLES,
  ORGANIZATION_STATUSES,
  POLICY_APPROVAL_MODES,
  POLICY_EFFECTS,
  POLICY_MATCH_TYPES,
  POLICY_RESOURCE_TYPES,
  POLICY_SCOPE_TYPES,
  STORAGE_ACCESS_TYPES,
  STORAGE_DURABILITIES,
  STORAGE_INSTANCE_STATUSES,
  STORAGE_PROVIDERS,
  STORAGE_SCOPE_TYPES,
  TASK_STATUSES,
  TERMINAL_TOOL_CALL_STATUSES,
  TOOL_APPROVAL_MODES,
  TOOL_CALL_STATUSES,
  TOOL_ROLE_BINDING_STATUSES,
  TOOL_ROLE_SELECTOR_TYPES,
  TOOL_SOURCE_SCOPE_TYPES,
  TOOL_SOURCE_TYPES,
} from "../../../core/src/types";

// Core enum validators shared by Convex schema and function args.
export const accountProviderValidator = literals(...ACCOUNT_PROVIDERS);
export const accountStatusValidator = literals(...ACCOUNT_STATUSES);
export const organizationStatusValidator = literals(...ORGANIZATION_STATUSES);
export const orgRoleValidator = literals(...ORGANIZATION_ROLES);
export const orgMemberStatusValidator = literals(...ORGANIZATION_MEMBER_STATUSES);

export const billingSubscriptionStatusValidator = literals(...BILLING_SUBSCRIPTION_STATUSES);

export const inviteStatusValidator = literals(...INVITE_STATUSES);

export const taskStatusValidator = literals(...TASK_STATUSES);

export const jsonObjectValidator = v.record(v.string(), v.any());

export const completedTaskStatusValidator = literals(...COMPLETED_TASK_STATUSES);

export const approvalStatusValidator = literals(...APPROVAL_STATUSES);

export const toolCallStatusValidator = literals(...TOOL_CALL_STATUSES);

export const toolApprovalModeValidator = literals(...TOOL_APPROVAL_MODES);

export const terminalToolCallStatusValidator = literals(...TERMINAL_TOOL_CALL_STATUSES);

export const policyScopeTypeValidator = literals(...POLICY_SCOPE_TYPES);
export const policyResourceTypeValidator = literals(...POLICY_RESOURCE_TYPES);
export const policyMatchTypeValidator = literals(...POLICY_MATCH_TYPES);
export const policyEffectValidator = literals(...POLICY_EFFECTS);
export const policyApprovalModeValidator = literals(...POLICY_APPROVAL_MODES);
export const toolRoleSelectorTypeValidator = literals(...TOOL_ROLE_SELECTOR_TYPES);
export const toolRoleBindingStatusValidator = literals(...TOOL_ROLE_BINDING_STATUSES);
export const argumentConditionOperatorValidator = literals(...ARGUMENT_CONDITION_OPERATORS);
export const argumentConditionValidator = v.object({
  key: v.string(),
  operator: argumentConditionOperatorValidator,
  value: v.string(),
});
export const toolSourceScopeTypeValidator = literals(...TOOL_SOURCE_SCOPE_TYPES);
export const credentialScopeTypeValidator = literals(...CREDENTIAL_SCOPE_TYPES);

export const credentialProviderValidator = literals(...CREDENTIAL_PROVIDERS);

export const credentialAdditionalHeaderValidator = v.object({
  name: v.string(),
  value: v.string(),
});

export const credentialAdditionalHeadersValidator = v.array(credentialAdditionalHeaderValidator);

export const toolSourceTypeValidator = literals(...TOOL_SOURCE_TYPES);

export const storageScopeTypeValidator = literals(...STORAGE_SCOPE_TYPES);

export const storageDurabilityValidator = literals(...STORAGE_DURABILITIES);

export const storageInstanceStatusValidator = literals(...STORAGE_INSTANCE_STATUSES);

export const storageProviderValidator = literals(...STORAGE_PROVIDERS);

export const storageAccessTypeValidator = literals(...STORAGE_ACCESS_TYPES);
