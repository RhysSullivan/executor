import { useId } from "react";
import { PlusIcon } from "lucide-react";
import type { ScopeId, SecretBackedValue } from "@executor/sdk";

import { Button } from "../components/button";
import { CardStack, CardStackContent, CardStackEntry } from "../components/card-stack";
import { Field, FieldGroup, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import { HeadersList } from "./headers-list";
import {
  CreatableSecretPicker,
  headerValueToState,
  headersFromState,
  type HeaderState,
} from "./secret-header-auth";
import type { SecretPickerSecret } from "./secret-picker";

export type { SecretBackedValue };

export type QueryParamState = {
  name: string;
  secretId: string | null;
  prefix?: string;
  literalValue?: string;
};

export type HttpCredentialsState = {
  headers: HeaderState[];
  queryParams: QueryParamState[];
};

export const emptyHttpCredentials = (): HttpCredentialsState => ({
  headers: [],
  queryParams: [],
});

export const httpCredentialsFromValues = (input: {
  readonly headers?: Record<string, SecretBackedValue> | null;
  readonly queryParams?: Record<string, SecretBackedValue> | null;
}): HttpCredentialsState => ({
  headers: Object.entries(input.headers ?? {}).map(([name, value]) =>
    headerValueToState(name, value),
  ),
  queryParams: Object.entries(input.queryParams ?? {}).map(([name, value]) => {
    if (typeof value === "string") {
      return { name, secretId: null, literalValue: value };
    }
    return { name, secretId: value.secretId, prefix: value.prefix };
  }),
});

export const serializeHeaderCredentials = (
  headers: readonly HeaderState[],
): Record<string, { secretId: string; prefix?: string }> => headersFromState(headers);

export const serializeQueryCredentials = (
  queryParams: readonly QueryParamState[],
): Record<string, SecretBackedValue> => {
  const result: Record<string, SecretBackedValue> = {};
  for (const param of queryParams) {
    const name = param.name.trim();
    if (!name) continue;
    if (param.secretId) {
      result[name] = {
        secretId: param.secretId,
        ...(param.prefix ? { prefix: param.prefix } : {}),
      };
      continue;
    }
    if (param.literalValue?.trim()) {
      result[name] = param.literalValue.trim();
    }
  }
  return result;
};

export const serializeHttpCredentials = (
  credentials: HttpCredentialsState,
): {
  readonly headers: Record<string, { secretId: string; prefix?: string }>;
  readonly queryParams: Record<string, SecretBackedValue>;
} => ({
  headers: serializeHeaderCredentials(credentials.headers),
  queryParams: serializeQueryCredentials(credentials.queryParams),
});

export const httpCredentialsValid = (credentials: HttpCredentialsState): boolean =>
  credentials.headers.every((header) => header.name.trim() && header.secretId) &&
  credentials.queryParams.every((param) => {
    if (!param.name.trim()) return false;
    return Boolean(param.secretId || param.literalValue?.trim());
  });

export function HttpCredentialsEditor(props: {
  readonly credentials: HttpCredentialsState;
  readonly onChange: (credentials: HttpCredentialsState) => void;
  readonly existingSecrets: readonly SecretPickerSecret[];
  readonly sourceName?: string;
  readonly targetScope?: ScopeId;
  readonly writeScope?: ScopeId;
  readonly sections?: {
    readonly headers?: boolean;
    readonly queryParams?: boolean;
  };
  readonly labels?: {
    readonly headers?: string;
    readonly queryParams?: string;
  };
}) {
  const showHeaders = props.sections?.headers ?? true;
  const showQueryParams = props.sections?.queryParams ?? true;

  return (
    <div className="space-y-4">
      {showHeaders && (
        <section className="space-y-2.5">
          <FieldLabel>{props.labels?.headers ?? "Headers"}</FieldLabel>
          <HeadersList
            headers={props.credentials.headers}
            onHeadersChange={(headers) => props.onChange({ ...props.credentials, headers })}
            existingSecrets={props.existingSecrets}
            sourceName={props.sourceName}
            targetScope={props.targetScope ?? props.writeScope}
          />
        </section>
      )}

      {showQueryParams && (
        <section className="space-y-2.5">
          <FieldLabel>{props.labels?.queryParams ?? "Query parameters"}</FieldLabel>
          <QueryParamsList
            queryParams={props.credentials.queryParams}
            onQueryParamsChange={(queryParams) =>
              props.onChange({ ...props.credentials, queryParams })
            }
            existingSecrets={props.existingSecrets}
            sourceName={props.sourceName}
            targetScope={props.targetScope ?? props.writeScope}
          />
        </section>
      )}
    </div>
  );
}

function QueryParamsList(props: {
  readonly queryParams: readonly QueryParamState[];
  readonly onQueryParamsChange: (queryParams: QueryParamState[]) => void;
  readonly existingSecrets: readonly SecretPickerSecret[];
  readonly sourceName?: string;
  readonly targetScope?: ScopeId;
}) {
  const addParam = () => {
    props.onQueryParamsChange([...props.queryParams, { name: "", secretId: null }]);
  };
  const updateParam = (index: number, update: Partial<QueryParamState>) => {
    props.onQueryParamsChange(
      props.queryParams.map((param, i) => (i === index ? { ...param, ...update } : param)),
    );
  };
  const removeParam = (index: number) => {
    props.onQueryParamsChange(props.queryParams.filter((_, i) => i !== index));
  };

  return (
    <CardStack>
      <CardStackContent className="[&>*+*]:before:inset-x-0">
        {props.queryParams.length === 0 ? (
          <AddQueryParamRow leading={<span>No query parameters</span>} onClick={addParam} />
        ) : (
          <>
            {props.queryParams.map((param, index) => (
              <QueryParamRow
                key={index}
                param={param}
                existingSecrets={props.existingSecrets}
                sourceName={props.sourceName}
                targetScope={props.targetScope}
                onChange={(update) => updateParam(index, update)}
                onRemove={() => removeParam(index)}
              />
            ))}
            <AddQueryParamRow onClick={addParam} />
          </>
        )}
      </CardStackContent>
    </CardStack>
  );
}

function QueryParamRow(props: {
  readonly param: QueryParamState;
  readonly existingSecrets: readonly SecretPickerSecret[];
  readonly sourceName?: string;
  readonly targetScope?: ScopeId;
  readonly onChange: (update: Partial<QueryParamState>) => void;
  readonly onRemove: () => void;
}) {
  const nameInputId = useId();
  const prefixInputId = useId();
  const literalInputId = useId();
  const name = props.param.name.trim();
  const secretLabel = name ? `${name} query parameter` : "Query parameter";

  return (
    <div className="space-y-2.5 px-4 py-3">
      <div className="flex w-full items-center justify-between gap-4">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Query parameter
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground hover:text-destructive"
          onClick={props.onRemove}
        >
          Remove
        </Button>
      </div>

      <FieldGroup className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor={nameInputId}>Name</FieldLabel>
          <Input
            id={nameInputId}
            value={props.param.name}
            onChange={(event) => props.onChange({ name: event.currentTarget.value })}
            placeholder="token"
            className="font-mono"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={prefixInputId}>
            Prefix <span className="font-normal text-muted-foreground/60">(optional)</span>
          </FieldLabel>
          <Input
            id={prefixInputId}
            value={props.param.prefix ?? ""}
            onChange={(event) => props.onChange({ prefix: event.currentTarget.value || undefined })}
            placeholder="Bearer "
            className="font-mono"
          />
        </Field>
      </FieldGroup>

      <CreatableSecretPicker
        value={props.param.secretId}
        onSelect={(secretId) => props.onChange({ secretId, literalValue: undefined })}
        secrets={props.existingSecrets}
        placeholder="Select a secret"
        sourceName={props.sourceName}
        secretLabel={secretLabel}
        targetScope={props.targetScope}
      />

      {!props.param.secretId && props.param.literalValue !== undefined && (
        <Field>
          <FieldLabel htmlFor={literalInputId}>Literal value</FieldLabel>
          <Input
            id={literalInputId}
            value={props.param.literalValue}
            onChange={(event) => props.onChange({ literalValue: event.currentTarget.value })}
            placeholder="value"
            className="font-mono"
          />
        </Field>
      )}
    </div>
  );
}

function AddQueryParamRow(props: {
  readonly onClick: () => void;
  readonly leading?: React.ReactNode;
}) {
  return (
    <CardStackEntry
      asChild
      className="justify-between gap-4 px-0 py-0 text-sm text-muted-foreground"
    >
      <Button
        type="button"
        variant="ghost"
        onClick={(event) => {
          event.stopPropagation();
          props.onClick();
        }}
        aria-label="Add query parameter"
        className="h-auto w-full justify-between rounded-none px-4 py-3 text-left text-muted-foreground hover:bg-accent/40 focus-visible:bg-accent/40"
      >
        <span className="min-w-0 flex-1">{props.leading}</span>
        <PlusIcon aria-hidden className="size-4 shrink-0" />
      </Button>
    </CardStackEntry>
  );
}
