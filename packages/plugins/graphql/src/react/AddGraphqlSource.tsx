import { useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { SecretHeaderAuthRow } from "@executor/react/plugins/secret-header-auth";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";
import { Button } from "@executor/react/components/button";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import { Spinner } from "@executor/react/components/spinner";
import { addGraphqlSource } from "./atoms";
import type { HeaderValue } from "../sdk/types";

type HeaderEntry = {
  name: string;
  prefix?: string;
  presetKey?: string;
  secretId: string | null;
};

const initialHeader = (): HeaderEntry => ({
  name: "Authorization",
  prefix: "Bearer ",
  presetKey: "bearer",
  secretId: null,
});

export default function AddGraphqlSource(props: {
  onComplete: () => void;
  onCancel: () => void;
  initialUrl?: string;
}) {
  const [endpoint, setEndpoint] = useState(props.initialUrl ?? "");
  const [namespace, setNamespace] = useState("");
  const [headers, setHeaders] = useState<HeaderEntry[]>([initialHeader()]);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const scopeId = useScope();
  const doAdd = useAtomSet(addGraphqlSource, { mode: "promise" });
  const secretList = useSecretPickerSecrets();

  const headersValid = headers.every(
    (header) => header.name.trim() && header.secretId,
  );
  const canAdd =
    endpoint.trim().length > 0 && (headers.length === 0 || headersValid);

  const updateHeader = (
    index: number,
    update: Partial<{ name: string; prefix?: string; presetKey?: string; secretId: string | null }>,
  ) => {
    setHeaders((current) =>
      current.map((header, i) => (i === index ? { ...header, ...update } : header)),
    );
  };

  const removeHeader = (index: number) => {
    setHeaders((current) => current.filter((_, i) => i !== index));
  };

  const addHeader = () => {
    setHeaders((current) => [
      ...current,
      { name: "", prefix: undefined, presetKey: undefined, secretId: null },
    ]);
  };

  const handleAdd = async () => {
    setAdding(true);
    setAddError(null);
    try {
      const headerMap: Record<string, HeaderValue> = {};
      for (const header of headers) {
        const name = header.name.trim();
        if (name && header.secretId) {
          headerMap[name] = {
            secretId: header.secretId,
            ...(header.prefix ? { prefix: header.prefix } : {}),
          };
        }
      }

      await doAdd({
        path: { scopeId },
        payload: {
          endpoint: endpoint.trim(),
          namespace: namespace.trim() || undefined,
          ...(Object.keys(headerMap).length > 0 ? { headers: headerMap } : {}),
        },
      });
      props.onComplete();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-foreground">Add GraphQL Source</h1>

      {/* Endpoint */}
      <section className="space-y-2">
        <Label>GraphQL Endpoint</Label>
        <Input
          value={endpoint}
          onChange={(e) => setEndpoint((e.target as HTMLInputElement).value)}
          placeholder="https://api.example.com/graphql"
          className="font-mono text-sm"
        />
        <p className="text-[12px] text-muted-foreground">
          The endpoint will be introspected to discover available queries and mutations.
        </p>
      </section>

      {/* Namespace */}
      <section className="space-y-2">
        <Label>
          Namespace <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          value={namespace}
          onChange={(e) => setNamespace((e.target as HTMLInputElement).value)}
          placeholder="my_api"
          className="font-mono text-sm"
        />
        <p className="text-[12px] text-muted-foreground">
          A prefix for the tool names. Derived from the endpoint hostname if not provided.
        </p>
      </section>

      {/* Authentication */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>
              Authentication <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Secret-backed headers sent with every request, including introspection.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={addHeader}
          >
            + Add header
          </Button>
        </div>

        {headers.length > 0 && (
          <div className="space-y-2">
            {headers.map((header, index) => (
              <SecretHeaderAuthRow
                key={index}
                name={header.name}
                prefix={header.prefix}
                presetKey={header.presetKey}
                secretId={header.secretId}
                onChange={(update) => updateHeader(index, update)}
                onSelectSecret={(secretId) => updateHeader(index, { secretId })}
                onRemove={() => removeHeader(index)}
                existingSecrets={secretList}
              />
            ))}
          </div>
        )}
      </section>

      {/* Error */}
      {addError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{addError}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onCancel} disabled={adding}>
          Cancel
        </Button>
        <Button onClick={handleAdd} disabled={!canAdd || adding}>
          {adding && <Spinner className="size-3.5" />}
          {adding ? "Adding..." : "Add source"}
        </Button>
      </div>
    </div>
  );
}
