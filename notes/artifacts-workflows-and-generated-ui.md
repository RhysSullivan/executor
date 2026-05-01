# Artifacts, Workflows, and Generated UI

codex resume 019ddfa8-00c6-7502-ae32-ceb6d85b2976

Executor core should stay small: tools, sources, secrets, permissions, and
invocation. Workflows and generated UI are "just Git and code", but that
should not pull a versioned filesystem into the core SDK.

The shared foundation is an optional artifact protocol package.

```txt
@executor/sdk
  tools
  sources
  secrets
  permissions
  invocation
  elicitation

@executor/artifacts
  ArtifactStore contract
  artifact refs
  project/version/commit schemas
  diff/file/change types
  artifact errors

@executor/artifacts-cloudflare
  provider plugin for Cloudflare Artifacts

@executor/artifacts-local-git
  isomorphic-git-backed provider for tests and development

@executor/workflows
  feature plugin that requires ArtifactStore

@executor/generative-ui
  feature plugin that requires ArtifactStore
```

## Why not core

Artifacts are not required to call tools safely. A user who only wants tool
execution should not install or configure artifact storage.

Artifacts are still useful enough to standardize because multiple higher-level
features need the same versioned file-tree abstraction:

- workflows
- generated components
- generated full UIs
- templates
- previews
- tests and fixtures
- agent work branches
- rollback and forks

The protocol package is official, but it is not core. Use `@executor/artifacts`
for the protocol package. Provider plugins import its constants and implement
its contracts; feature plugins import the same constants and require them.

## Artifact projects

Do not make this workflow-specific. Model the generic thing as an artifact
project, with workflows as the first consumer.

```ts
type ArtifactKind =
  | "workflow"
  | "component"
  | "ui"
  | "template"
  | "connector"
  | "document";

type ArtifactProject = {
  id: string;
  ownerId: string;
  kind: ArtifactKind;
  name: string;
  defaultBranch: string;
  currentCommit: string;
  createdAt: Date;
  updatedAt: Date;
};
```

The app database indexes product metadata and permissions. The artifact store
owns file trees and history.

Database answers:

- Which artifacts does this user or workspace own?
- Which commit is current or published?
- Who can read/write it?
- Which runs, previews, or deployments point at it?

Artifact storage answers:

- What files existed at commit X?
- What changed between two versions?
- Can an agent fork/edit this tree?
- Can we clone, export, replay, or roll back it?

## File layout

Every artifact project should have a manifest at the root.

```txt
artifact.json
src/
tests/
fixtures/
preview/
```

Workflow artifact:

```txt
artifact.json
src/workflows/support-triage.workflow.ts
src/steps/
workflow.manifest.json
tests/workflow.test.ts
fixtures/sample-input.json
```

Generated UI artifact:

```txt
artifact.json
src/App.tsx
src/components/
src/styles.css
ui.manifest.json
tests/
preview/
```

Generated component artifact:

```txt
artifact.json
src/index.tsx
src/demo.tsx
props.schema.json
component.manifest.json
tests/
preview/
```

## ArtifactStore shape

Keep the protocol boring. No workflow concepts, UI concepts, Cloudflare
concepts, or agent concepts.

```ts
export type ArtifactRef = {
  projectId: string;
  ref: string; // branch, tag, or commit
};

export type ArtifactCommit = {
  id: string;
  message: string;
  parentIds: readonly string[];
  createdAt: Date;
};

export interface ArtifactStore {
  readonly createProject: (
    input: CreateArtifactProjectInput,
  ) => Effect.Effect<ArtifactProject, ArtifactError>;

  readonly readFile: (
    ref: ArtifactRef,
    path: string,
  ) => Effect.Effect<Uint8Array, ArtifactError>;

  readonly writeFiles: (
    input: WriteArtifactFilesInput,
  ) => Effect.Effect<ArtifactCommit, ArtifactError>;

  readonly diff: (
    input: ArtifactDiffInput,
  ) => Effect.Effect<ArtifactDiff, ArtifactError>;

  readonly forkProject: (
    input: ForkArtifactProjectInput,
  ) => Effect.Effect<ArtifactProject, ArtifactError>;
}
```

Cloudflare Artifacts is the likely first production provider because it is
versioned file-tree storage that speaks Git and can be accessed from Workers,
REST, and Git clients. The Cloudflare package should implement the protocol,
not define the product model.

`@executor/artifacts-local-git` should likely use `isomorphic-git`, not shell
out to a Git binary. Cloudflare Artifacts exposes standard Git smart HTTP
remotes, and Cloudflare documents `isomorphic-git` as working with Artifacts in
Workers when no Git binary or local disk is available. Using it locally gives
us one Git implementation path that can also work in Workers with an in-memory
filesystem.

## Protocol provider selection

Secret storage is the closest existing pattern. Secret providers register
unique provider keys, routes can pin a secret to a provider, and writes can
name a provider explicitly. Protocol providers should reuse that shape instead
of inventing a separate dependency system.

The general shape:

```ts
createExecutor({
  plugins: [artifactsLocal(), artifactsCloudflare(), workflows()],
  protocols: {
    "executor.artifacts.store": "artifacts-cloudflare",
  },
});
```

Rules:

- provider plugins expose a unique plugin/provider id
- protocol packages expose stable capability constants
- feature plugins require protocol capabilities by importing those constants
- if exactly one installed provider satisfies a required protocol, use it
- if multiple installed providers satisfy a required protocol, require explicit
  selection in executor config
- optional protocol requirements can be absent without failing startup

This is intentionally stricter than secret writes. Picking the "first writable"
secret provider is acceptable for convenience because each secret route is
pinned after creation. Picking the first artifact store would be risky because
workflows, generated UI, previews, and runs depend on stable file history.

## Workflows

Workflows should be a feature plugin, not core.

The workflow plugin owns:

- code indexing for `"use workflow"` files
- derived workflow graph/manifests
- code transforms for visual edits
- validation
- code generation
- run model
- runtime adapter
- workflow tools such as `workflows.create`, `workflows.update`,
  `workflows.validate`, and `workflows.run`

The artifact store owns:

- versioned workflow files
- commit history
- forks
- diffs
- rollback

Workflow code is canonical. The graph is a derived UI/index, not the source of
truth.

```txt
code -> indexed graph -> visual editor
visual edit -> code transform -> commit -> re-index graph
commit -> run pinned to commit -> observable steps
```

Runs should always pin the artifact commit they executed. This gives
reproducibility, rollback, and a clean audit trail.

`"use workflow"` and `"use step"` are the syntax that make code indexable:

- workflow function = graph root
- awaited step calls = action nodes
- arguments = data mappings
- `if` statements = branches
- `Promise.all` = parallel branches
- `sleep`, hooks, or webhooks = wait/resume nodes
- return value = workflow output

The manifest is derived, like an index or lockfile. It can be stored for fast
UI rendering/search, but source files are canonical.

## Generated UI

Generated UI and generated components should use the same artifact foundation.
Source files are canonical; manifests and previews are derived.

The generative UI plugin owns:

- UI/component manifests
- preview build pipeline
- test/validation pipeline
- publish/deploy hooks
- generated UI tools

The shared artifact protocol means workflows, components, and full UIs can all
use the same versioning, forking, diffing, preview, and rollback primitives.

## Zapier-style product foundation

The workflow plugin is the start of a Zapier competitor, but the first landing
should only establish the spine:

1. artifact protocol and provider
2. workflow code conventions around `"use workflow"` and `"use step"`
3. code indexer that derives a graph/manifest
4. connector/action metadata for humans
5. validation pipeline
6. run records pinned to artifact commits
7. basic run history and step logs

Later product layers can add triggers, polling cursors, schedules, templates,
branching, approvals, retries, replay, connector marketplaces, and richer data
mapping.

The durable `"use workflow"` model is the right canonical representation, but
the Workflow SDK "world" concept should not leak to users. Users see
workflows, runs, steps, approvals, waits, and logs.

## TypeScript sketch

Protocol package:

```ts
// @executor/artifacts
import type { Effect } from "effect";
import type { PluginProtocolProvider } from "@executor/sdk";

export const ArtifactStoreProtocol = {
  key: "executor.artifacts.store",
  label: "Artifact Store",
} as const satisfies PluginProtocolProvider<"executor.artifacts.store">;

export type ArtifactRef = {
  projectId: string;
  ref: string; // branch, tag, or commit
};

export type ArtifactProject = {
  id: string;
  kind: "workflow" | "component" | "ui" | "template" | "connector" | "document";
  name: string;
  defaultBranch: string;
  currentCommit: string;
};

export type ArtifactCommit = {
  id: string;
  message: string;
  parentIds: readonly string[];
  createdAt: Date;
};

export type ArtifactFileChange =
  | { type: "put"; path: string; contents: Uint8Array | string }
  | { type: "delete"; path: string };

export interface ArtifactStore {
  readonly createProject: (input: {
    kind: ArtifactProject["kind"];
    name: string;
  }) => Effect.Effect<ArtifactProject, ArtifactError>;

  readonly readFile: (
    ref: ArtifactRef,
    path: string,
  ) => Effect.Effect<Uint8Array, ArtifactError>;

  readonly writeFiles: (input: {
    projectId: string;
    baseRef: string;
    branch: string;
    message: string;
    changes: readonly ArtifactFileChange[];
  }) => Effect.Effect<ArtifactCommit, ArtifactError>;

  readonly diff: (input: {
    projectId: string;
    baseRef: string;
    headRef: string;
  }) => Effect.Effect<ArtifactDiff, ArtifactError>;

  readonly forkProject: (input: {
    projectId: string;
    name: string;
  }) => Effect.Effect<ArtifactProject, ArtifactError>;
}

export type ArtifactsProtocolCtx = {
  readonly artifacts: ArtifactStore;
};
```

Provider plugin:

```ts
// @executor/artifacts-local-git
import { definePlugin } from "@executor/sdk";
import { ArtifactStoreProtocol, type ArtifactStore } from "@executor/artifacts";

export const artifactsLocalGitPlugin = (options: { rootDir: string }) =>
  definePlugin(() => {
    const artifacts: ArtifactStore = makeIsomorphicGitArtifactStore(options);

    return {
      id: "artifacts-local-git" as const,
      provides: [ArtifactStoreProtocol],
      storage: () => ({}),
      protocols: () => ({
        artifacts,
      }),
    };
  })();
```

Feature plugin:

```ts
// @executor/workflows
import { definePlugin, type PluginCtx } from "@executor/sdk";
import {
  ArtifactStoreProtocol,
  type ArtifactsProtocolCtx,
} from "@executor/artifacts";

type WorkflowCtx<TStore> = PluginCtx<TStore, ArtifactsProtocolCtx>;

export const workflowsPlugin = definePlugin(() => ({
  id: "workflows" as const,
  requires: [{ ...ArtifactStoreProtocol, reason: "persist workflow code" }],
  storage: () => ({}),

  extension: (ctx: WorkflowCtx<{}>) => ({
    create: (input: { name: string; files: readonly ArtifactFileChange[] }) =>
      Effect.gen(function* () {
        const project = yield* ctx.artifacts.createProject({
          kind: "workflow",
          name: input.name,
        });

        const commit = yield* ctx.artifacts.writeFiles({
          projectId: project.id,
          baseRef: project.defaultBranch,
          branch: project.defaultBranch,
          message: `Create workflow ${input.name}`,
          changes: input.files,
        });

        const manifest = yield* indexWorkflowCode({
          projectId: project.id,
          ref: commit.id,
          artifacts: ctx.artifacts,
        });

        return { project, commit, manifest };
      }),
  }),
}));
```

Executor composition:

```ts
const executor =
  yield *
  createExecutor({
    scopes: [userScope],
    adapter,
    blobs,
    plugins: [
      artifactsLocalGitPlugin({ rootDir: ".executor-artifacts" }),
      workflowsPlugin(),
    ] as const,
    protocols: {
      "executor.artifacts.store": "artifacts-local-git",
    },
  });

const workflow =
  yield *
  executor.workflows.create({
    name: "Support triage",
    files: [
      {
        type: "put",
        path: "artifact.json",
        contents: JSON.stringify({
          schemaVersion: 1,
          kind: "workflow",
          entrypoints: ["src/workflows/support-triage.workflow.ts"],
        }),
      },
      {
        type: "put",
        path: "src/workflows/support-triage.workflow.ts",
        contents: supportTriageWorkflowSource,
      },
      {
        type: "put",
        path: "src/steps/summarize.ts",
        contents: summarizeStepSource,
      },
    ],
  });
```

Generated workflow code:

```ts
// src/workflows/support-triage.workflow.ts
import { createLinearIssue } from "../steps/linear";
import { summarizeTicket } from "../steps/summarize";

export async function supportTriage(input: SupportEmail) {
  "use workflow";

  const summary = await summarizeTicket(input);

  if (summary.priority === "high") {
    return await createLinearIssue({
      title: summary.title,
      body: summary.body,
    });
  }

  return { status: "ignored", summary };
}
```

```ts
// src/steps/summarize.ts
export async function summarizeTicket(input: SupportEmail) {
  "use step";

  return await tools.openai.responses.create({
    model: "gpt-5.1",
    input: `Summarize and classify: ${input.body}`,
  });
}
```

E2E flow:

```ts
it.effect(
  "creates a code-first workflow artifact and indexes a visual graph",
  () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor({
        scopes: [testScope],
        adapter,
        blobs,
        plugins: [
          artifactsLocalGitPlugin({ rootDir: tempDir }),
          workflowsPlugin(),
        ] as const,
        protocols: {
          "executor.artifacts.store": "artifacts-local-git",
        },
      });

      const created = yield* executor.workflows.create({
        name: "Support triage",
        files: [
          {
            type: "put",
            path: "artifact.json",
            contents: JSON.stringify({
              schemaVersion: 1,
              kind: "workflow",
              entrypoints: ["src/workflows/support-triage.workflow.ts"],
            }),
          },
          {
            type: "put",
            path: "src/workflows/support-triage.workflow.ts",
            contents: supportTriageWorkflowSource,
          },
        ],
      });

      const source = yield* executor.artifacts.readFile(
        { projectId: created.project.id, ref: created.commit.id },
        "src/workflows/support-triage.workflow.ts",
      );
      expect(new TextDecoder().decode(source)).toContain('"use workflow"');

      expect(created.manifest.entrypoints).toEqual([
        "src/workflows/support-triage.workflow.ts",
      ]);
      expect(created.manifest.graph.nodes.map((node) => node.kind)).toContain(
        "step",
      );
    }),
);
```

## Todos

- [ ] Rename protocol dependency keys to namespaced constants such as
      `executor.artifacts.store`.
- [ ] Extend plugin dependency metadata so protocol constants can carry typed
      context fragments.
- [ ] Add `PluginCtx<TStore, TProtocolCtx>` and support direct protocol fields
      such as `ctx.artifacts` without adding artifacts to base core ctx.
- [ ] Add executor-level protocol provider selection config.
- [ ] Fail startup when multiple providers satisfy a required protocol and no
      explicit provider selection exists.
- [ ] Create `@executor/artifacts` protocol package.
- [ ] Define `ArtifactStore`, artifact refs, commits, diffs, file changes,
      project metadata, manifest schema, and artifact errors.
- [ ] Export `ArtifactStoreProtocol` and `ArtifactsProtocolCtx` from
      `@executor/artifacts`.
- [ ] Create `@executor/artifacts-local-git` using `isomorphic-git`.
- [ ] Add local Git provider tests for create project, write files, read files,
      diff, and fork.
- [ ] Create `@executor/artifacts-cloudflare` provider against Cloudflare
      Artifacts.
- [ ] Add Cloudflare provider support for repo creation, commit writes, refs,
      token handling, and clone/fetch/push flows.
- [ ] Define required `artifact.json` root manifest format.
- [ ] Add manifest validation shared by artifact providers/features.
- [ ] Create `@executor/workflows` feature plugin.
- [ ] Define code-first workflow conventions for `"use workflow"` entrypoints
      and `"use step"` functions.
- [ ] Build a workflow code indexer that derives graph/manifest data from
      source files.
- [ ] Add validation for workflow entrypoints, step references, tool calls,
      required connector metadata, and artifact manifest consistency.
- [ ] Store derived `workflow.manifest.json` as an index, not canonical source.
- [ ] Add workflow tools for create, update, validate, inspect, and preview.
- [ ] Add code transform path for visual workflow edits.
- [ ] Add run records that pin artifact project id, provider id, ref, and
      commit.
- [ ] Defer full durable execution until build/runtime wiring for generated
      `"use workflow"` artifacts is clear.
- [ ] Create `@executor/generative-ui` feature plugin after artifact protocol is
      stable.
- [ ] Define generated UI/component manifests as derived indexes over source
      code.
- [ ] Add preview/build/test pipeline hooks for generated UI artifacts.
