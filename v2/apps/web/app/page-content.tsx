"use client";

import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import type { UpsertSourcePayload } from "@executor-v2/control-plane";
import type { SourceId, SourceKind, WorkspaceId } from "@executor-v2/schema";
import { useState, type FormEvent } from "react";

import {
  optimisticRemoveSources,
  optimisticSourcesByWorkspace,
  optimisticUpsertSources,
  removeSource,
  sourcesByWorkspace,
  sourcesPendingByWorkspace,
  sourcesResultByWorkspace,
  upsertSource,
} from "../lib/control-plane/atoms";

const kindOptions: ReadonlyArray<SourceKind> = [
  "openapi",
  "mcp",
  "graphql",
  "internal",
];

const Page = () => {
  const [workspaceIdInput, setWorkspaceIdInput] = useState("ws_demo");
  const [name, setName] = useState("Weather API");
  const [kind, setKind] = useState<SourceKind>("openapi");
  const [endpoint, setEndpoint] = useState("https://example.com/openapi.json");
  const [statusText, setStatusText] = useState<string | null>(null);

  const workspaceId = workspaceIdInput as WorkspaceId;

  const sources = useAtomValue(sourcesByWorkspace(workspaceId));
  const sourcesPending = useAtomValue(sourcesPendingByWorkspace(workspaceId));
  const refreshSources = useAtomRefresh(sourcesResultByWorkspace(workspaceId));

  const runUpsertSource = useAtomSet(upsertSource, { mode: "promise" });
  const runRemoveSource = useAtomSet(removeSource, { mode: "promise" });
  const setOptimisticSources = useAtomSet(optimisticSourcesByWorkspace(workspaceId));

  const handleWorkspaceChange = (value: string) => {
    setWorkspaceIdInput(value);
    setStatusText(null);
  };

  const handleAddSource = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (sourcesPending) {
      return;
    }

    const sourceId = `src_${crypto.randomUUID()}` as SourceId;

    const payload: UpsertSourcePayload = {
      id: sourceId,
      name,
      kind,
      endpoint,
      enabled: true,
      configJson: "{}",
      status: "draft",
      sourceHash: null,
      lastError: null,
    };

    const previousSources = sources.items;
    const optimistic = optimisticUpsertSources(previousSources, workspaceId, payload);

    setOptimisticSources({
      items: optimistic.items,
      pendingAck: {
        kind: "upsert",
        sourceId: optimistic.sourceId,
      },
    });

    void runUpsertSource({
      path: { workspaceId },
      payload,
    })
      .then(() => {
        setStatusText("Source saved.");
        refreshSources();
      })
      .catch(() => {
        setStatusText("Source save failed.");
        setOptimisticSources(null);
        refreshSources();
      });
  };

  const handleRemoveSource = (sourceId: SourceId) => {
    if (sourcesPending) {
      return;
    }

    const previousSources = sources.items;
    const optimistic = optimisticRemoveSources(previousSources, sourceId);

    setOptimisticSources({
      items: optimistic.items,
      pendingAck: {
        kind: "remove",
        sourceId: optimistic.sourceId,
      },
    });

    void runRemoveSource({
      path: { workspaceId, sourceId },
    })
      .then(() => {
        setStatusText("Source removed.");
        refreshSources();
      })
      .catch(() => {
        setStatusText("Source removal failed.");
        setOptimisticSources(null);
        refreshSources();
      });
  };

  return (
    <main>
      <section className="shell">
        <header className="hero">
          <h1>Executor v2 Control Plane</h1>
          <p>
            Basic Next.js frontend wired to the shared Effect HttpApi client via
            Effect Atom.
          </p>
        </header>

        <div className="grid">
          <section className="card">
            <h2>Workspace + Source</h2>
            <form onSubmit={handleAddSource}>
              <div className="field">
                <label htmlFor="workspace-id">Workspace ID</label>
                <input
                  id="workspace-id"
                  value={workspaceIdInput}
                  onChange={(event) => handleWorkspaceChange(event.target.value)}
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="source-name">Name</label>
                <input
                  id="source-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </div>

              <div className="field">
                <label htmlFor="source-kind">Kind</label>
                <select
                  id="source-kind"
                  value={kind}
                  onChange={(event) => setKind(event.target.value as SourceKind)}
                >
                  {kindOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="source-endpoint">Endpoint</label>
                <input
                  id="source-endpoint"
                  value={endpoint}
                  onChange={(event) => setEndpoint(event.target.value)}
                  required
                />
              </div>

              <button className="primary" type="submit" disabled={sourcesPending}>
                {sourcesPending ? "Saving..." : "Save Source"}
              </button>
            </form>

            {statusText ? <p className="status">{statusText}</p> : null}
          </section>

          <section className="card">
            <h2>Sources</h2>

            {sources.state === "loading" ? (
              <p className="status">Loading sources...</p>
            ) : null}

            {sources.state === "error" ? (
              <p className="status error">{sources.message}</p>
            ) : null}

            {sources.state !== "loading" && sources.items.length === 0 ? (
              <p className="status">No sources yet in this workspace.</p>
            ) : null}

            <div className="list">
              {sources.items.map((source) => (
                <article className="list-item" key={source.id}>
                  <header>
                    <div>
                      <strong>{source.name}</strong>
                      <div className="meta">
                        {source.kind} · {source.status}
                      </div>
                      <div className="meta">{source.endpoint}</div>
                    </div>
                    <button
                      className="danger"
                      type="button"
                      onClick={() => handleRemoveSource(source.id)}
                      disabled={sourcesPending}
                    >
                      Remove
                    </button>
                  </header>
                </article>
              ))}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
};

export default Page;
