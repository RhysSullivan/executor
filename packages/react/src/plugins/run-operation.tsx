import { useMemo, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";
import { executeCode } from "../api/atoms";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { Textarea } from "../components/textarea";
import { Checkbox } from "../components/checkbox";
import { Label } from "../components/label";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { CardStack, CardStackContent, CardStackHeader } from "../components/card-stack";

interface RunResult {
  readonly status: "completed" | "paused";
  readonly text: string;
  readonly isError: boolean;
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  description?: string;
  title?: string;
  default?: unknown;
  nullable?: boolean;
  format?: string;
  oneOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
};

const resolveRef = (ref: string, root: JsonSchema): JsonSchema | null => {
  const name = ref.match(/^#\/\$defs\/(.+)$/)?.[1];
  if (!name || !root.$defs) return null;
  return root.$defs[name] ?? null;
};

const resolve = (schema: JsonSchema, root: JsonSchema): JsonSchema => {
  let s = schema;
  if (s.$ref) {
    const r = resolveRef(s.$ref, root);
    if (r) s = r;
  }
  if (s.oneOf?.length === 1) s = resolve(s.oneOf[0]!, root);
  if (s.anyOf?.length === 1) s = resolve(s.anyOf[0]!, root);
  return s;
};

const primaryType = (s: JsonSchema): string | undefined => {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== "null");
  return s.type;
};

type FieldKind =
  | { kind: "string"; enum?: readonly unknown[] }
  | { kind: "number" }
  | { kind: "integer" }
  | { kind: "boolean" }
  | { kind: "json"; hint: string };

const classifyField = (schema: JsonSchema, root: JsonSchema): FieldKind => {
  const s = resolve(schema, root);

  if (s.enum && s.enum.length > 0) {
    return { kind: "string", enum: s.enum };
  }

  const t = primaryType(s);
  if (t === "boolean") return { kind: "boolean" };
  if (t === "integer") return { kind: "integer" };
  if (t === "number") return { kind: "number" };
  if (t === "string") return { kind: "string" };

  if (t === "array") return { kind: "json", hint: "[]" };
  if (t === "object") return { kind: "json", hint: "{}" };

  return { kind: "json", hint: "null" };
};

type FormValue = string | number | boolean | null;

const initialFieldValue = (field: FieldKind, schema: JsonSchema): FormValue => {
  if (schema.default !== undefined) {
    if (field.kind === "json") {
      try {
        return JSON.stringify(schema.default, null, 2);
      } catch {
        return "";
      }
    }
    if (typeof schema.default === "string" || typeof schema.default === "number" || typeof schema.default === "boolean") {
      return schema.default;
    }
  }

  if (field.kind === "boolean") return false;
  if (field.kind === "string" && field.enum && field.enum.length > 0) {
    const first = field.enum[0];
    return typeof first === "string" || typeof first === "number" ? String(first) : "";
  }
  return "";
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RunOperationPanel({
  toolId,
  inputSchema,
}: {
  toolId: string;
  inputSchema?: unknown;
}) {
  const properties = useMemo(() => {
    const root = (inputSchema ?? null) as JsonSchema | null;
    const resolvedRoot = root ? resolve(root, root) : null;
    if (!resolvedRoot || primaryType(resolvedRoot) !== "object" || !resolvedRoot.properties) {
      return null;
    }
    const required = new Set(resolvedRoot.required ?? []);
    return Object.entries(resolvedRoot.properties).map(([name, propSchema]) => {
      const resolvedProp = resolve(propSchema, root!);
      const field = classifyField(propSchema, root!);
      return {
        name,
        schema: resolvedProp,
        field,
        required: required.has(name),
      };
    });
  }, [inputSchema]);

  const [values, setValues] = useState<Record<string, FormValue>>(() => {
    if (!properties) return {};
    const initial: Record<string, FormValue> = {};
    for (const p of properties) initial[p.name] = initialFieldValue(p.field, p.schema);
    return initial;
  });
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => {
    if (!properties) return {};
    const init: Record<string, boolean> = {};
    for (const p of properties) init[p.name] = p.required || p.schema.default !== undefined;
    return init;
  });
  const [rawJson, setRawJson] = useState("{}");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const doExecute = useAtomSet(executeCode, { mode: "promise" });

  const buildArgs = (): { ok: true; args: unknown } | { ok: false; error: string } => {
    if (!properties) {
      const trimmed = rawJson.trim();
      if (trimmed.length === 0) return { ok: true, args: {} };
      try {
        return { ok: true, args: JSON.parse(trimmed) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Invalid JSON" };
      }
    }

    const args: Record<string, unknown> = {};
    for (const p of properties) {
      if (!enabled[p.name] && !p.required) continue;
      const raw = values[p.name];
      if (p.field.kind === "boolean") {
        args[p.name] = Boolean(raw);
      } else if (p.field.kind === "integer") {
        if (raw === "" || raw === null) {
          if (p.required) return { ok: false, error: `"${p.name}" is required` };
          continue;
        }
        const n = Number(raw);
        if (!Number.isInteger(n)) return { ok: false, error: `"${p.name}" must be an integer` };
        args[p.name] = n;
      } else if (p.field.kind === "number") {
        if (raw === "" || raw === null) {
          if (p.required) return { ok: false, error: `"${p.name}" is required` };
          continue;
        }
        const n = Number(raw);
        if (Number.isNaN(n)) return { ok: false, error: `"${p.name}" must be a number` };
        args[p.name] = n;
      } else if (p.field.kind === "string") {
        if (raw === "" || raw === null) {
          if (p.required) return { ok: false, error: `"${p.name}" is required` };
          continue;
        }
        args[p.name] = String(raw);
      } else {
        const trimmed = typeof raw === "string" ? raw.trim() : "";
        if (trimmed.length === 0) {
          if (p.required) return { ok: false, error: `"${p.name}" is required` };
          continue;
        }
        try {
          args[p.name] = JSON.parse(trimmed);
        } catch (e) {
          return {
            ok: false,
            error: `"${p.name}": ${e instanceof Error ? e.message : "Invalid JSON"}`,
          };
        }
      }
    }
    return { ok: true, args };
  };

  const handleRun = async () => {
    setParseError(null);
    setResult(null);

    const built = buildArgs();
    if (!built.ok) {
      setParseError(built.error);
      return;
    }

    const code = `return await tools.${toolId}(${JSON.stringify(built.args)});`;

    setRunning(true);
    try {
      const response = await doExecute({ payload: { code } });
      if (response.status === "completed") {
        setResult({ status: "completed", text: response.text, isError: response.isError });
      } else {
        setResult({ status: "paused", text: response.text, isError: false });
      }
    } catch (e) {
      setResult({
        status: "completed",
        text: e instanceof Error ? e.message : String(e),
        isError: true,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <CardStack>
        <CardStackHeader>Parameters</CardStackHeader>
        <CardStackContent>
          <div className="flex flex-col gap-4 p-4">
            {properties ? (
              properties.length === 0 ? (
                <p className="text-xs text-muted-foreground">No parameters.</p>
              ) : (
                properties.map((p) => (
                  <FieldRow
                    key={p.name}
                    name={p.name}
                    field={p.field}
                    schema={p.schema}
                    required={p.required}
                    value={values[p.name] ?? ""}
                    enabled={enabled[p.name] ?? false}
                    onValueChange={(v) =>
                      setValues((prev) => ({ ...prev, [p.name]: v }))
                    }
                    onEnabledChange={(v) =>
                      setEnabled((prev) => ({ ...prev, [p.name]: v }))
                    }
                  />
                ))
              )
            ) : (
              <div className="flex flex-col gap-2">
                <Label className="text-xs text-muted-foreground">
                  Input (JSON)
                </Label>
                <Textarea
                  value={rawJson}
                  onChange={(e) => setRawJson(e.target.value)}
                  className="font-mono text-xs"
                  rows={6}
                  spellCheck={false}
                  placeholder="{}"
                />
              </div>
            )}

            {parseError && (
              <p className="text-xs text-destructive">{parseError}</p>
            )}
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void handleRun()} disabled={running}>
                {running ? "Running…" : "Run"}
              </Button>
            </div>
          </div>
        </CardStackContent>
      </CardStack>

      {result && (
        <CardStack>
          <CardStackHeader>
            {result.status === "paused"
              ? "Paused (awaiting elicitation)"
              : result.isError
                ? "Error"
                : "Result"}
          </CardStackHeader>
          <CardStackContent>
            <pre
              className={[
                "overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs",
                result.isError ? "text-destructive" : "text-foreground",
              ].join(" ")}
            >
              {result.text || "(empty)"}
            </pre>
          </CardStackContent>
        </CardStack>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field row
// ---------------------------------------------------------------------------

function FieldRow({
  name,
  field,
  schema,
  required,
  value,
  enabled,
  onValueChange,
  onEnabledChange,
}: {
  name: string;
  field: FieldKind;
  schema: JsonSchema;
  required: boolean;
  value: FormValue;
  enabled: boolean;
  onValueChange: (v: FormValue) => void;
  onEnabledChange: (v: boolean) => void;
}) {
  const disabled = !required && !enabled;
  const description = schema.description;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {!required && (
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) => onEnabledChange(v === true)}
            aria-label={`Include ${name}`}
          />
        )}
        <Label className="font-mono text-xs">
          {name}
          {required && <span className="ml-1 text-destructive">*</span>}
          <span className="ml-2 font-sans font-normal text-muted-foreground">
            {fieldTypeLabel(field, schema)}
          </span>
        </Label>
      </div>

      {field.kind === "boolean" ? (
        <div className="flex items-center">
          <Checkbox
            checked={value === true}
            onCheckedChange={(v) => onValueChange(v === true)}
            disabled={disabled}
          />
        </div>
      ) : field.kind === "string" && field.enum ? (
        <NativeSelect
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onValueChange((e.target as HTMLSelectElement).value)}
          disabled={disabled}
          className="text-sm"
        >
          {field.enum.map((v) => {
            const str = typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v);
            return (
              <NativeSelectOption key={str} value={str}>
                {str}
              </NativeSelectOption>
            );
          })}
        </NativeSelect>
      ) : field.kind === "json" ? (
        <Textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onValueChange(e.target.value)}
          disabled={disabled}
          className="font-mono text-xs"
          rows={3}
          spellCheck={false}
          placeholder={field.hint}
        />
      ) : (
        <Input
          type={field.kind === "integer" || field.kind === "number" ? "number" : "text"}
          step={field.kind === "integer" ? 1 : "any"}
          value={typeof value === "string" || typeof value === "number" ? value : ""}
          onChange={(e) => onValueChange(e.target.value)}
          disabled={disabled}
          placeholder={schema.default !== undefined ? String(schema.default) : ""}
        />
      )}

      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}

const fieldTypeLabel = (field: FieldKind, schema: JsonSchema): string => {
  if (field.kind === "string" && field.enum) return "enum";
  if (field.kind === "json") {
    const t = primaryType(schema);
    return t ?? "json";
  }
  return field.kind;
};
