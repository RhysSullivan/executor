import type {
  Execution,
  ExecutionEnvelope,
} from "@executor/react";
import {
  useExecution,
  useExecutions,
} from "@executor/react";
import {
  Badge,
  DocumentPanel,
  EmptyState,
  LoadableBlock,
  useExecutorPluginNavigation,
  useExecutorPluginRouteParams,
} from "@executor/react/plugins";

const formatTimestamp = (value: number | null): string => {
  if (value === null) {
    return "—";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
};

const formatDuration = (execution: Execution): string | null => {
  if (execution.startedAt === null || execution.completedAt === null) {
    return null;
  }

  const durationMs = Math.max(0, execution.completedAt - execution.startedAt);
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1_000).toFixed(1)} s`;
  }

  return `${(durationMs / 60_000).toFixed(1)} min`;
};

const summarizeCode = (code: string): string =>
  code
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 220);

const formatJsonDocument = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

const statusVariant = (
  status: Execution["status"],
): "default" | "muted" | "outline" | "destructive" => {
  switch (status) {
    case "completed":
      return "default";
    case "failed":
      return "destructive";
    case "running":
    case "waiting_for_interaction":
      return "outline";
    default:
      return "muted";
  }
};

const MetadataItem = (props: {
  label: string;
  value: string;
}) => (
  <div className="rounded-lg border border-border bg-card/60 px-3 py-2">
    <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
      {props.label}
    </div>
    <div className="mt-1 text-sm text-foreground">{props.value}</div>
  </div>
);

const ExecutionCard = (props: {
  execution: Execution;
  onOpen: () => void;
}) => {
  const { execution } = props;

  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="w-full rounded-2xl border border-border bg-card px-5 py-4 text-left transition-colors hover:border-primary/25 hover:bg-card/90"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-semibold text-foreground">
              {execution.id}
            </div>
            <Badge variant={statusVariant(execution.status)}>
              {execution.status.replaceAll("_", " ")}
            </Badge>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Created {formatTimestamp(execution.createdAt)}
            {formatDuration(execution) ? ` • ${formatDuration(execution)}` : ""}
          </div>
          <p className="mt-3 line-clamp-3 text-sm leading-6 text-muted-foreground">
            {summarizeCode(execution.code) || "No code captured."}
          </p>
        </div>
      </div>

      {execution.errorText && (
        <div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {execution.errorText}
        </div>
      )}
    </button>
  );
};

export function ExecutionHistoryPage() {
  const executions = useExecutions();
  const navigation = useExecutorPluginNavigation();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8">
          <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Execution history
          </h1>
          <p className="mt-1.5 text-[14px] text-muted-foreground">
            Every execution recorded for this workspace, newest first.
          </p>
        </div>

        <LoadableBlock loadable={executions} loading="Loading executions...">
          {(items) =>
            items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border py-20">
                <EmptyState
                  title="No executions yet"
                  description="Run something and it will show up here."
                />
              </div>
            ) : (
              <div className="grid gap-3">
                {items.map((execution) => (
                  <ExecutionCard
                    key={execution.id}
                    execution={execution}
                    onOpen={() => {
                      void navigation.route(execution.id);
                    }}
                  />
                ))}
              </div>
            )
          }
        </LoadableBlock>
      </div>
    </div>
  );
}

const ExecutionDetailSections = (props: {
  envelope: ExecutionEnvelope;
}) => {
  const { execution, pendingInteraction } = props.envelope;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetadataItem label="Status" value={execution.status.replaceAll("_", " ")} />
        <MetadataItem label="Created" value={formatTimestamp(execution.createdAt)} />
        <MetadataItem label="Started" value={formatTimestamp(execution.startedAt)} />
        <MetadataItem
          label="Completed"
          value={formatTimestamp(execution.completedAt)}
        />
      </div>

      <DocumentPanel
        title="Code"
        body={execution.code}
        lang="ts"
        empty="No code captured."
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <DocumentPanel
          title="Result"
          body={formatJsonDocument(execution.resultJson)}
          lang="json"
          empty="No result recorded."
        />
        <DocumentPanel
          title="Logs"
          body={formatJsonDocument(execution.logsJson)}
          lang="json"
          empty="No logs recorded."
        />
      </div>

      {execution.errorText && (
        <DocumentPanel
          title="Error"
          body={execution.errorText}
          lang="text"
          empty="No error recorded."
        />
      )}

      {pendingInteraction && (
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Pending interaction
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {pendingInteraction.kind} • {pendingInteraction.purpose}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <MetadataItem label="Kind" value={pendingInteraction.kind} />
            <MetadataItem label="Purpose" value={pendingInteraction.purpose} />
            <MetadataItem
              label="Status"
              value={pendingInteraction.status.replaceAll("_", " ")}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <DocumentPanel
              title="Request"
              body={formatJsonDocument(pendingInteraction.payloadJson)}
              lang="json"
              empty="No interaction request recorded."
            />
            <DocumentPanel
              title="Response"
              body={formatJsonDocument(pendingInteraction.responseJson)}
              lang="json"
              empty="No interaction response recorded."
            />
          </div>
        </div>
      )}
    </div>
  );
};

export function ExecutionHistoryDetailPage() {
  const { executionId } = useExecutorPluginRouteParams<{
    executionId: string;
  }>();
  const navigation = useExecutorPluginNavigation();
  const execution = useExecution(executionId);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <button
              type="button"
              onClick={() => {
                void navigation.route();
              }}
              className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
            >
              Back to history
            </button>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-2xl tracking-tight text-foreground lg:text-3xl">
                {executionId}
              </h1>
            </div>
          </div>
        </div>

        <LoadableBlock loadable={execution} loading="Loading execution...">
          {(envelope) => <ExecutionDetailSections envelope={envelope} />}
        </LoadableBlock>
      </div>
    </div>
  );
}
