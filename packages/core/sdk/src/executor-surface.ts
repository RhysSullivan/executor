import { Duration, Effect, Match, Option } from "effect";

import {
  ElicitationDeclinedError,
  ElicitationResponse,
  FormElicitation,
  type ElicitationHandler,
  type ElicitationRequest,
} from "./elicitation";
import {
  NoHandlerError,
  PluginNotLoadedError,
  SourceRemovalNotAllowedError,
  ToolBlockedError,
  ToolInvocationError,
  ToolNotFoundError,
} from "./errors";
import { makePolicyFacade } from "./executor-policy-facade";
import {
  approvalArgumentPreview,
  byId,
  byScopedId,
  decodeJsonColumn,
  deleteSourceById,
  makeCoreDb,
  pluginStorageFailure,
  rowToSource,
  rowToTool,
  scopedWhere,
  staticDeclToSource,
  staticDeclToTool,
  toToolJsonSchema,
  toolMatchesFilter,
} from "./executor-helpers";
import type { StorageFailure } from "./fuma-runtime";
import { validateHostedOutboundUrl } from "./hosted-http-client";
import { ToolId } from "./ids";
import type { Elicit, PluginCtx, StaticSourceDecl, StaticToolDecl } from "./plugin";
import { resolveToolPolicy, type PolicyMatch } from "./policies";
import { buildToolTypeScriptPreview } from "./schema-types";
import {
  ToolSchema,
  type RefreshSourceInput,
  type RemoveSourceInput,
  type Source,
  type SourceDetectionResult,
  type Tool,
  type ToolListFilter,
} from "./types";
import type { ToolAnnotations, ToolRow } from "./core-schema";
import { StorageError } from "./fuma-runtime";

const MAX_ANNOTATION_GROUPS = 64;

type OnElicitation = ElicitationHandler | "accept-all";
type InvokeOptions = { readonly onElicitation?: OnElicitation };

type StaticTools = {
  readonly source: StaticSourceDecl;
  readonly tool: StaticToolDecl;
  readonly pluginId: string;
  readonly ctx: PluginCtx<unknown>;
};

type StaticSources = {
  readonly source: StaticSourceDecl;
  readonly pluginId: string;
};

type PluginRuntime = {
  readonly plugin: {
    readonly id: string;
    readonly resolveAnnotations?: (input: {
      readonly ctx: PluginCtx<unknown>;
      readonly sourceId: string;
      readonly toolRows: readonly ToolRow[];
    }) => Effect.Effect<Record<string, ToolAnnotations>, unknown>;
    readonly invokeTool?: (input: {
      readonly ctx: PluginCtx<unknown>;
      readonly toolRow: ToolRow;
      readonly args: unknown;
      readonly elicit: Elicit;
    }) => Effect.Effect<unknown, unknown>;
    readonly removeSource?: (input: {
      readonly ctx: PluginCtx<unknown>;
      readonly sourceId: string;
      readonly scope: string;
    }) => Effect.Effect<unknown, unknown>;
    readonly refreshSource?: (input: {
      readonly ctx: PluginCtx<unknown>;
      readonly sourceId: string;
      readonly scope: string;
    }) => Effect.Effect<unknown, unknown>;
    readonly detect?: (input: {
      readonly ctx: PluginCtx<unknown>;
      readonly url: string;
    }) => Effect.Effect<SourceDetectionResult | null, unknown>;
  };
  readonly ctx: PluginCtx<unknown>;
};

export const makeExecutorSurface = (deps: {
  readonly core: ReturnType<typeof makeCoreDb>;
  readonly scopeIds: readonly string[];
  readonly scopeRank: (row: { readonly scope_id: unknown }) => number;
  readonly findInnermost: <T extends { readonly scope_id: unknown }>(
    rows: readonly T[],
  ) => T | null;
  readonly staticTools: ReadonlyMap<string, StaticTools>;
  readonly staticSources: ReadonlyMap<string, StaticSources>;
  readonly runtimes: ReadonlyMap<string, PluginRuntime>;
  readonly transaction: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | StorageFailure>;
  readonly assertScopeInStack: (
    label: string,
    scopeId: string,
  ) => Effect.Effect<void, StorageError>;
  readonly onElicitation: OnElicitation;
  readonly resolveElicitationHandler: (onElicitation: OnElicitation) => ElicitationHandler;
  readonly sourceDetection?: {
    readonly maxUrlLength?: number;
    readonly maxDetectors?: number;
    readonly maxResults?: number;
    readonly timeout?: Duration.Input;
    readonly hostedOutboundPolicy?: boolean;
  };
  readonly hostedOutboundPolicyDefault: boolean;
}) => {
  const {
    core,
    scopeIds,
    scopeRank,
    findInnermost,
    staticTools,
    staticSources,
    runtimes,
    transaction,
    assertScopeInStack,
    onElicitation,
    resolveElicitationHandler,
    sourceDetection,
    hostedOutboundPolicyDefault,
  } = deps;

  const listSources = () =>
    Effect.gen(function* () {
      const dynamic = yield* core.findMany("source", { where: scopedWhere(scopeIds) });
      // Dedup by id with innermost scope winning. Without this, a user
      // who shadowed an org-wide source at their inner scope would see
      // two rows — their override and the outer default — which is
      // inconsistent with how `secrets.list` and every other list
      // surface dedup shadowed entries.
      const byId = new Map<string, (typeof dynamic)[number]>();
      const byIdRank = new Map<string, number>();
      for (const row of dynamic) {
        const rank = scopeRank(row);
        const existing = byIdRank.get(row.id);
        if (existing === undefined || rank < existing) {
          byId.set(row.id, row);
          byIdRank.set(row.id, rank);
        }
      }
      const dynamicDeduped = [...byId.values()];
      const staticList: Source[] = [];
      for (const { source, pluginId } of staticSources.values()) {
        staticList.push(staticDeclToSource(source, pluginId));
      }
      const merged = [...staticList, ...dynamicDeduped.map(rowToSource)];
      yield* Effect.annotateCurrentSpan({
        "executor.sources.static_count": staticList.length,
        "executor.sources.dynamic_count": dynamicDeduped.length,
      });
      return merged;
    }).pipe(Effect.withSpan("executor.sources.list"));

  // Bulk-resolve annotations across a set of dynamic tool rows by
  // grouping them under their owning plugin's resolveAnnotations
  // callback. One plugin call per (plugin_id, source_id) pair, not
  // per row. Plugins without a resolver simply contribute no
  // annotations for their rows.
  const resolveAnnotationsFor = (rows: readonly ToolRow[]) =>
    Effect.gen(function* () {
      const result = new Map<string, ToolAnnotations>();
      if (rows.length === 0) return result;

      // Group by (plugin_id, source_id)
      const groups = new Map<string, ToolRow[]>();
      for (const row of rows) {
        const key = `${row.plugin_id}\u0000${row.source_id}`;
        const bucket = groups.get(key);
        if (bucket) bucket.push(row);
        else groups.set(key, [row]);
      }

      // Each (plugin_id, source_id) group is an independent DB read,
      // so fan them out concurrently. Yielding them serially stacks
      // ~200-300ms storage round-trips end-to-end and dominates the
      // `executor.tools.list.annotations` span.
      const maps = yield* Effect.forEach(
        [...groups].slice(0, MAX_ANNOTATION_GROUPS),
        ([key, groupRows]) =>
          Effect.gen(function* () {
            const [pluginId, sourceId] = key.split("\u0000") as [string, string];
            const runtime = runtimes.get(pluginId);
            if (!runtime?.plugin.resolveAnnotations) return undefined;
            return yield* runtime.plugin
              .resolveAnnotations({
                ctx: runtime.ctx,
                sourceId,
                toolRows: groupRows,
              })
              .pipe(
                Effect.mapError((cause) =>
                  pluginStorageFailure(pluginId, "resolveAnnotations", cause),
                ),
              );
          }),
        { concurrency: "unbounded" },
      );
      for (const map of maps) {
        if (!map) continue;
        for (const [toolId, annotations] of Object.entries(map)) {
          result.set(toolId, annotations);
        }
      }
      return result;
    });

  const listTools = (filter?: ToolListFilter) =>
    Effect.gen(function* () {
      const dynamic = yield* core.findMany("tool", {
        where: scopedWhere(
          scopeIds,
          filter?.sourceId ? (b) => b("source_id", "=", filter.sourceId!) : undefined,
        ),
      });
      // Dedup by tool id, innermost scope winning — same reason as
      // `listSources` above: a shadowed id must surface as one entry
      // (the inner one), not two.
      const byId = new Map<string, (typeof dynamic)[number]>();
      const byIdRank = new Map<string, number>();
      for (const row of dynamic) {
        const rank = scopeRank(row);
        const existing = byIdRank.get(row.id);
        if (existing === undefined || rank < existing) {
          byId.set(row.id, row);
          byIdRank.set(row.id, rank);
        }
      }
      const dynamicDeduped = [...byId.values()];
      const annotations =
        filter?.includeAnnotations === false
          ? new Map<string, ToolAnnotations>()
          : yield* resolveAnnotationsFor(dynamicDeduped).pipe(
              Effect.withSpan("executor.tools.list.annotations"),
            );

      const out: Tool[] = [];
      // Static tools — annotations from the declaration, not a resolver.
      for (const entry of staticTools.values()) {
        out.push(staticDeclToTool(entry.source, entry.tool, entry.pluginId));
      }
      for (const row of dynamicDeduped) {
        out.push(rowToTool(row, annotations.get(row.id)));
      }
      const filtered = filter ? out.filter((t) => toolMatchesFilter(t, filter)) : out;

      // Drop tools blocked by user policy unless the caller explicitly
      // asked to see them (the settings UI does, agent surfaces don't).
      // One findMany covers the entire scope stack; resolution per
      // tool is in-memory.
      let result = filtered;
      let blockedCount = 0;
      if (filter?.includeBlocked !== true) {
        const policies = yield* loadAllPolicies();
        if (policies.length > 0) {
          const kept: Tool[] = [];
          for (const tool of filtered) {
            const match = resolveToolPolicy(tool.id, policies, scopeRank);
            if (match?.action === "block") {
              blockedCount++;
              continue;
            }
            kept.push(tool);
          }
          result = kept;
        }
      }

      yield* Effect.annotateCurrentSpan({
        "executor.tools.static_count": staticTools.size,
        "executor.tools.dynamic_count": dynamicDeduped.length,
        "executor.tools.result_count": result.length,
        "executor.tools.blocked_count": blockedCount,
      });
      return result;
    }).pipe(Effect.withSpan("executor.tools.list"));

  // Load all definitions for a single source as a plain map. Defs
  // for the same name can exist at multiple scopes (an admin registers
  // a default, a user overrides one entry with a tighter schema) —
  // dedup by name keeping the innermost-scope row.
  const loadDefinitionsForSource = (sourceId: string) =>
    Effect.gen(function* () {
      const defRows = yield* core.findMany("definition", {
        where: scopedWhere(scopeIds, (b) => b("source_id", "=", sourceId)),
      });
      const winners = new Map<string, { row: (typeof defRows)[number]; rank: number }>();
      for (const row of defRows) {
        const rank = scopeRank(row);
        const existing = winners.get(row.name);
        if (!existing || rank < existing.rank) {
          winners.set(row.name, { row, rank });
        }
      }
      const out: Record<string, unknown> = {};
      for (const [name, { row }] of winners) out[name] = row.schema;
      return out;
    });

  // Render the ToolSchema view for a tool — wraps the raw JSON schemas
  // with attached `$defs` and runs them through the TypeScript preview
  // helpers so the UI gets ready-to-display code samples.
  const buildToolSchemaView = (opts: {
    toolId: string;
    name?: string;
    description?: string;
    sourceId: string | undefined;
    rawInput: unknown;
    rawOutput: unknown;
  }) =>
    Effect.gen(function* () {
      const defs: Record<string, unknown> = opts.sourceId
        ? yield* loadDefinitionsForSource(opts.sourceId).pipe(
            Effect.withSpan("executor.tool.schema.load_defs"),
          )
        : {};

      const attachDefs = (schema: unknown): unknown => {
        if (schema == null || typeof schema !== "object") return schema;
        if (Object.keys(defs).length === 0) return schema;
        return { ...(schema as Record<string, unknown>), $defs: defs };
      };

      const inputSchema = attachDefs(opts.rawInput);
      const outputSchema = attachDefs(opts.rawOutput);

      const defsMap = new Map<string, unknown>(Object.entries(defs));
      const preview = yield* Effect.sync(() =>
        buildToolTypeScriptPreview({
          inputSchema,
          outputSchema,
          defs: defsMap,
        }),
      ).pipe(
        Effect.withSpan("schema.compile.preview", {
          attributes: {
            "schema.kind": "tool.preview",
            "schema.has_input": inputSchema !== undefined,
            "schema.has_output": outputSchema !== undefined,
            "schema.def_count": defsMap.size,
          },
        }),
      );

      return ToolSchema.make({
        id: ToolId.make(opts.toolId),
        name: opts.name,
        description: opts.description,
        inputSchema,
        outputSchema,
        inputTypeScript: preview.inputTypeScript ?? undefined,
        outputTypeScript: preview.outputTypeScript ?? undefined,
        typeScriptDefinitions: preview.typeScriptDefinitions ?? undefined,
      });
    });

  const toolSchema = (toolId: string) =>
    Effect.gen(function* () {
      // Static pool first — static tools have no source in the DB so
      // no `$defs` attach; just wrap the declared schemas.
      const staticEntry = staticTools.get(toolId);
      if (staticEntry) {
        yield* Effect.annotateCurrentSpan({
          "executor.tool.dispatch_path": "static",
          "executor.source_id": staticEntry.source.id,
          "executor.source_kind": staticEntry.source.kind,
        });
        return yield* buildToolSchemaView({
          toolId,
          name: staticEntry.tool.name,
          description: staticEntry.tool.description,
          sourceId: undefined,
          rawInput: toToolJsonSchema(staticEntry.tool.inputSchema),
          rawOutput: toToolJsonSchema(staticEntry.tool.outputSchema, "output"),
        });
      }
      // Innermost-wins lookup across every visible scope.
      const rows = yield* core
        .findMany("tool", {
          where: scopedWhere(scopeIds, byId(toolId)),
        })
        .pipe(Effect.withSpan("executor.tool.resolve"));
      const row = findInnermost(rows);
      if (!row) return null;
      yield* Effect.annotateCurrentSpan({
        "executor.tool.dispatch_path": "dynamic",
        "executor.source_id": row.source_id,
        "executor.plugin_id": row.plugin_id,
      });
      return yield* buildToolSchemaView({
        toolId,
        name: row.name,
        description: row.description,
        sourceId: row.source_id,
        rawInput: decodeJsonColumn(row.input_schema),
        rawOutput: decodeJsonColumn(row.output_schema),
      });
    }).pipe(
      Effect.withSpan("executor.tool.schema", {
        attributes: { "mcp.tool.name": toolId },
      }),
    );

  // Bulk definitions accessor — every source's $defs, grouped by
  // source id. One query against the definition table, plus an
  // in-memory group-by with innermost-scope dedup: if the same
  // (source_id, name) pair exists at multiple scopes, the inner
  // scope's schema wins.
  const toolsDefinitions = () =>
    Effect.gen(function* () {
      const rows = yield* core.findMany("definition", { where: scopedWhere(scopeIds) });
      const winners = new Map<string, { row: (typeof rows)[number]; rank: number }>();
      for (const row of rows) {
        const key = `${row.source_id}\u0000${row.name}`;
        const rank = scopeRank(row);
        const existing = winners.get(key);
        if (!existing || rank < existing.rank) {
          winners.set(key, { row, rank });
        }
      }
      const out: Record<string, Record<string, unknown>> = {};
      for (const { row } of winners.values()) {
        let bucket = out[row.source_id];
        if (!bucket) {
          bucket = {};
          out[row.source_id] = bucket;
        }
        bucket[row.name] = row.schema;
      }
      return out;
    });

  const defaultElicitationHandler = resolveElicitationHandler(onElicitation);
  const pickHandler = (options: InvokeOptions | undefined): ElicitationHandler =>
    options?.onElicitation
      ? resolveElicitationHandler(options.onElicitation)
      : defaultElicitationHandler;

  const buildElicit = (toolId: string, args: unknown, handler: ElicitationHandler): Elicit => {
    return (request: ElicitationRequest) =>
      Effect.gen(function* () {
        const tid = ToolId.make(toolId);
        const response: ElicitationResponse = yield* handler({
          toolId: tid,
          args,
          request,
        });
        if (response.action !== "accept") {
          return yield* new ElicitationDeclinedError({
            toolId: tid,
            action: response.action,
          });
        }
        return response;
      });
  };

  // ------------------------------------------------------------------
  // Tool policies — user-authored overrides of the plugin-derived
  // approval annotations. Resolution walks the scope-stacked policy
  // table with first-match-wins ordering (innermost scope first, then
  // `position` ascending). The result either short-circuits invoke
  // (`block`), forces approval (`require_approval`), skips approval
  // (`approve`), or returns `undefined` so the plugin annotation is
  // used as today.
  // ------------------------------------------------------------------

  const policyFacade = makePolicyFacade({
    core,
    scopeIds,
    scopeRank,
    assertScopeInStack,
  });
  const loadAllPolicies = policyFacade.loadAll;
  const resolveToolPolicyForId = policyFacade.resolveForId;

  const enforceApproval = (
    annotations: ToolAnnotations | undefined,
    toolId: string,
    args: unknown,
    policy: PolicyMatch | undefined,
    handler: ElicitationHandler,
  ) =>
    Effect.gen(function* () {
      // approve → never prompt regardless of plugin annotation.
      if (policy?.action === "approve") return;

      // require_approval → always prompt. If the plugin already had a
      // description, prefer it; otherwise show the matched pattern so
      // the user can see *why* the prompt fired.
      const policyForcesApproval = policy?.action === "require_approval";
      if (!policyForcesApproval && !annotations?.requiresApproval) return;

      const tid = ToolId.make(toolId);
      const message = annotations?.approvalDescription
        ? annotations.approvalDescription
        : policyForcesApproval && policy
          ? `Approve ${toolId}? (matched policy: ${policy.pattern})`
          : `Approve ${toolId}?`;
      const request = FormElicitation.make({
        message: `${message}\n\nArguments:\n${approvalArgumentPreview(args)}`,
        requestedSchema: {
          type: "object",
          properties: {},
        },
      });
      const response = yield* handler({ toolId: tid, args, request });
      if (response.action !== "accept") {
        return yield* new ElicitationDeclinedError({
          toolId: tid,
          action: response.action,
        });
      }
    });

  const invokeTool = (toolId: string, args: unknown, options?: InvokeOptions) => {
    const handler = pickHandler(options);
    return Effect.gen(function* () {
      const formatInvocationCauseMessage = (cause: unknown): string => {
        // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: preserve public invoke error message wrapping for unknown plugin failures
        return cause instanceof Error ? cause.message : String(cause);
      };
      const wrapInvocationError = <A, E>(
        effect: Effect.Effect<A, E>,
      ): Effect.Effect<A, ToolInvocationError> =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ToolInvocationError({
                toolId: ToolId.make(toolId),
                message: formatInvocationCauseMessage(cause),
                cause,
              }),
          ),
        );

      // Resolve the user-authored policy first. A `block` rule
      // short-circuits both the static and dynamic paths before any
      // plugin code runs.
      const policy = yield* resolveToolPolicyForId(toolId).pipe(
        Effect.withSpan("executor.tool.resolve_policy"),
      );
      if (policy?.action === "block") {
        return yield* new ToolBlockedError({
          toolId: ToolId.make(toolId),
          pattern: policy.pattern,
        });
      }

      // Static path — O(1) map lookup, no DB hit.
      const staticEntry = staticTools.get(toolId);
      if (staticEntry) {
        yield* Effect.annotateCurrentSpan({
          "executor.tool.dispatch_path": "static",
          "executor.source_id": staticEntry.source.id,
          "executor.source_kind": staticEntry.source.kind,
          "executor.plugin_id": staticEntry.pluginId,
        });
        yield* enforceApproval(staticEntry.tool.annotations, toolId, args, policy, handler).pipe(
          Effect.withSpan("executor.tool.enforce_approval"),
        );
        return yield* wrapInvocationError(
          staticEntry.tool.handler({
            ctx: staticEntry.ctx,
            args,
            elicit: buildElicit(toolId, args, handler),
          }),
        ).pipe(Effect.withSpan("executor.tool.handler"));
      }

      // Dynamic path — DB lookup + delegate to owning plugin. Walk the
      // whole scope stack and pick the innermost-scope row so a user's
      // shadow of an outer tool actually wins on invoke.
      const toolRows = yield* core
        .findMany("tool", {
          where: scopedWhere(scopeIds, byId(toolId)),
        })
        .pipe(Effect.withSpan("executor.tool.resolve"));
      const row = findInnermost(toolRows);
      if (!row) {
        return yield* new ToolNotFoundError({
          toolId: ToolId.make(toolId),
        });
      }
      yield* Effect.annotateCurrentSpan({
        "executor.tool.dispatch_path": "dynamic",
        "executor.source_id": row.source_id,
        "executor.plugin_id": row.plugin_id,
      });
      const runtime = runtimes.get(row.plugin_id);
      if (!runtime) {
        return yield* new PluginNotLoadedError({
          pluginId: row.plugin_id,
          toolId: ToolId.make(toolId),
        });
      }
      if (!runtime.plugin.invokeTool) {
        return yield* new NoHandlerError({
          toolId: ToolId.make(toolId),
          pluginId: row.plugin_id,
        });
      }

      // Ask the plugin to derive annotations for this one row, if it
      // has a resolver. Cheap because the plugin typically already
      // needs to load its enrichment data to invoke the tool —
      // implementations should structure their resolver + invokeTool
      // around a single storage read. Skipped entirely when the user
      // policy is `approve` — the prompt is going to be skipped no
      // matter what the plugin says, so don't pay for the lookup.
      let annotations: ToolAnnotations | undefined;
      if (policy?.action !== "approve" && runtime.plugin.resolveAnnotations) {
        const map = yield* runtime.plugin
          .resolveAnnotations({
            ctx: runtime.ctx,
            sourceId: row.source_id,
            toolRows: [row],
          })
          .pipe(wrapInvocationError)
          .pipe(Effect.withSpan("executor.tool.resolve_annotations"));
        annotations = map[toolId];
      }
      yield* enforceApproval(annotations, toolId, args, policy, handler).pipe(
        Effect.withSpan("executor.tool.enforce_approval"),
      );

      return yield* wrapInvocationError(
        runtime.plugin.invokeTool({
          ctx: runtime.ctx,
          toolRow: row,
          args,
          elicit: buildElicit(toolId, args, handler),
        }),
      ).pipe(Effect.withSpan("executor.tool.handler"));
    }).pipe(
      Effect.withSpan("executor.tool.invoke", {
        attributes: {
          "mcp.tool.name": toolId,
        },
      }),
    );
  };

  const removeSource = (input: RemoveSourceInput) =>
    Effect.gen(function* () {
      yield* assertScopeInStack("source remove targetScope", input.targetScope);
      const sourceId = input.id;
      // Block removal of static sources structurally.
      if (staticSources.has(sourceId)) {
        return yield* new SourceRemovalNotAllowedError({ sourceId });
      }
      const sourceRow = yield* core.findFirst("source", {
        where: byScopedId(input.targetScope, sourceId),
      });
      if (!sourceRow) return;
      if (!sourceRow.can_remove) {
        return yield* new SourceRemovalNotAllowedError({ sourceId });
      }
      const runtime = runtimes.get(sourceRow.plugin_id);
      // Group the plugin's own cleanup + the core row delete into one
      // Fuma transaction so removeSource never leaves orphan rows on failure.
      yield* transaction(
        Effect.gen(function* () {
          if (runtime?.plugin.removeSource) {
            yield* runtime.plugin
              .removeSource({
                ctx: runtime.ctx,
                sourceId,
                scope: input.targetScope,
              })
              .pipe(
                Effect.mapError((cause) =>
                  pluginStorageFailure(runtime.plugin.id, "removeSource", cause),
                ),
              );
          }
          yield* deleteSourceById(core, sourceId, input.targetScope);
        }),
      );
    });

  const refreshSource = (input: RefreshSourceInput) =>
    Effect.gen(function* () {
      yield* assertScopeInStack("source refresh targetScope", input.targetScope);
      const sourceId = input.id;
      if (staticSources.has(sourceId)) return;
      const sourceRow = yield* core.findFirst("source", {
        where: byScopedId(input.targetScope, sourceId),
      });
      if (!sourceRow) return;
      const runtime = runtimes.get(sourceRow.plugin_id);
      if (runtime?.plugin.refreshSource) {
        yield* runtime.plugin
          .refreshSource({
            ctx: runtime.ctx,
            sourceId,
            scope: input.targetScope,
          })
          .pipe(
            Effect.mapError((cause) =>
              pluginStorageFailure(runtime.plugin.id, "refreshSource", cause),
            ),
          );
      }
    });

  const sourceDetectionMaxUrlLength = sourceDetection?.maxUrlLength ?? 2_048;
  const sourceDetectionMaxDetectors = sourceDetection?.maxDetectors ?? 6;
  const sourceDetectionMaxResults = sourceDetection?.maxResults ?? 4;
  const sourceDetectionTimeout = sourceDetection?.timeout ?? "60 seconds";
  const sourceDetectionHostedOutboundPolicy =
    sourceDetection?.hostedOutboundPolicy ?? hostedOutboundPolicyDefault;

  // URL autodetection — fan out across a bounded set of plugins that
  // declared a `detect` hook. Collect non-null results up to the
  // configured cap. Plugin-level detect implementations should
  // swallow fetch errors and return null, so one flaky plugin doesn't
  // block the whole dispatch.
  const detectionConfidenceScore = (confidence: SourceDetectionResult["confidence"]) =>
    Match.value(confidence).pipe(
      Match.when("high", () => 3),
      Match.when("medium", () => 2),
      Match.when("low", () => 1),
      Match.exhaustive,
    );

  const detectSource = (url: string) =>
    Effect.gen(function* () {
      const trimmed = url.trim();
      if (trimmed.length === 0 || trimmed.length > sourceDetectionMaxUrlLength) return [];
      const parsed = yield* Effect.try({
        try: () => new URL(trimmed),
        catch: (error) => error,
      }).pipe(Effect.option);
      if (Option.isNone(parsed)) return [];
      if (parsed.value.protocol !== "http:" && parsed.value.protocol !== "https:") return [];
      if (sourceDetectionHostedOutboundPolicy) {
        const allowed = yield* validateHostedOutboundUrl(trimmed).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!allowed) return [];
      }

      const results: SourceDetectionResult[] = [];
      let detectorCount = 0;
      for (const runtime of runtimes.values()) {
        if (!runtime.plugin.detect) continue;
        if (detectorCount >= sourceDetectionMaxDetectors) break;
        detectorCount++;
        const result = yield* runtime.plugin
          .detect({ ctx: runtime.ctx, url: trimmed })
          .pipe(Effect.timeout(sourceDetectionTimeout))
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (result) results.push(result);
      }
      return results
        .sort(
          (a, b) => detectionConfidenceScore(b.confidence) - detectionConfidenceScore(a.confidence),
        )
        .slice(0, sourceDetectionMaxResults);
    });

  // Per-source definitions accessor — one query, one mapping pass.
  const sourceDefinitions = (sourceId: string) => loadDefinitionsForSource(sourceId);

  return {
    policies: {
      create: policyFacade.create,
      list: policyFacade.list,
      remove: policyFacade.remove,
      resolve: policyFacade.resolve,
      update: policyFacade.update,
    },
    sources: {
      definitions: sourceDefinitions,
      detect: detectSource,
      list: listSources,
      refresh: refreshSource,
      remove: removeSource,
    },
    tools: {
      definitions: toolsDefinitions,
      invoke: invokeTool,
      list: listTools,
      schema: toolSchema,
    },
  };
};
