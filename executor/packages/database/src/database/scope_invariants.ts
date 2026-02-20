import type {
  CredentialScopeType,
  PolicyScopeType,
  StorageScopeType,
  ToolSourceScopeType,
} from "../../../core/src/types";

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function assertExactScopeFields(args: {
  scopeLabel: string;
  scopeType: string;
  required: Array<{ key: string; value: unknown }>;
  forbidden: Array<{ key: string; value: unknown }>;
}) {
  for (const field of args.required) {
    if (!isSet(field.value)) {
      throw new Error(`${args.scopeLabel} '${args.scopeType}' requires ${field.key}`);
    }
  }

  for (const field of args.forbidden) {
    if (isSet(field.value)) {
      throw new Error(`${args.scopeLabel} '${args.scopeType}' forbids ${field.key}`);
    }
  }
}

export function assertCredentialScopeFields(args: {
  scopeType: CredentialScopeType;
  workspaceId?: unknown;
  accountId?: unknown;
}) {
  if (args.scopeType === "workspace") {
    assertExactScopeFields({
      scopeLabel: "Credential scope",
      scopeType: args.scopeType,
      required: [{ key: "workspaceId", value: args.workspaceId }],
      forbidden: [{ key: "accountId", value: args.accountId }],
    });
    return;
  }

  if (args.scopeType === "organization") {
    assertExactScopeFields({
      scopeLabel: "Credential scope",
      scopeType: args.scopeType,
      required: [],
      forbidden: [
        { key: "workspaceId", value: args.workspaceId },
        { key: "accountId", value: args.accountId },
      ],
    });
    return;
  }

  assertExactScopeFields({
    scopeLabel: "Credential scope",
    scopeType: args.scopeType,
    required: [{ key: "accountId", value: args.accountId }],
    forbidden: [{ key: "workspaceId", value: args.workspaceId }],
  });
}

export function assertToolSourceScopeFields(args: {
  scopeType: ToolSourceScopeType;
  workspaceId?: unknown;
}) {
  if (args.scopeType === "workspace") {
    assertExactScopeFields({
      scopeLabel: "Tool source scope",
      scopeType: args.scopeType,
      required: [{ key: "workspaceId", value: args.workspaceId }],
      forbidden: [],
    });
    return;
  }

  assertExactScopeFields({
    scopeLabel: "Tool source scope",
    scopeType: args.scopeType,
    required: [],
    forbidden: [{ key: "workspaceId", value: args.workspaceId }],
  });
}

export function assertToolRoleBindingScopeFields(args: {
  scopeType: PolicyScopeType;
  workspaceId?: unknown;
  targetAccountId?: unknown;
}) {
  if (args.scopeType === "workspace") {
    assertExactScopeFields({
      scopeLabel: "Tool role binding scope",
      scopeType: args.scopeType,
      required: [{ key: "workspaceId", value: args.workspaceId }],
      forbidden: [{ key: "targetAccountId", value: args.targetAccountId }],
    });
    return;
  }

  if (args.scopeType === "organization") {
    assertExactScopeFields({
      scopeLabel: "Tool role binding scope",
      scopeType: args.scopeType,
      required: [],
      forbidden: [
        { key: "workspaceId", value: args.workspaceId },
        { key: "targetAccountId", value: args.targetAccountId },
      ],
    });
    return;
  }

  assertExactScopeFields({
    scopeLabel: "Tool role binding scope",
    scopeType: args.scopeType,
    required: [{ key: "targetAccountId", value: args.targetAccountId }],
    forbidden: [{ key: "workspaceId", value: args.workspaceId }],
  });
}

export function assertStorageScopeFields(args: {
  scopeType: StorageScopeType;
  workspaceId?: unknown;
  accountId?: unknown;
}) {
  if (args.scopeType === "scratch") {
    assertExactScopeFields({
      scopeLabel: "Storage scope",
      scopeType: args.scopeType,
      required: [
        { key: "workspaceId", value: args.workspaceId },
        { key: "accountId", value: args.accountId },
      ],
      forbidden: [],
    });
    return;
  }

  if (args.scopeType === "workspace") {
    assertExactScopeFields({
      scopeLabel: "Storage scope",
      scopeType: args.scopeType,
      required: [{ key: "workspaceId", value: args.workspaceId }],
      forbidden: [{ key: "accountId", value: args.accountId }],
    });
    return;
  }

  if (args.scopeType === "organization") {
    assertExactScopeFields({
      scopeLabel: "Storage scope",
      scopeType: args.scopeType,
      required: [],
      forbidden: [
        { key: "workspaceId", value: args.workspaceId },
        { key: "accountId", value: args.accountId },
      ],
    });
    return;
  }

  assertExactScopeFields({
    scopeLabel: "Storage scope",
    scopeType: args.scopeType,
    required: [{ key: "accountId", value: args.accountId }],
    forbidden: [{ key: "workspaceId", value: args.workspaceId }],
  });
}
