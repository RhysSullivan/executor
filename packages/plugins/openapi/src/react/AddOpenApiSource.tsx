import { useState, useMemo, createContext, useContext } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useAtomSet } from "@effect-atom/atom-react";
import { Option } from "effect";

import { previewOpenApiSpec, addOpenApiSpec } from "./atoms";
import type { SpecPreview } from "../sdk/preview";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type Navigate = (to: string) => void;
const NavContext = createContext<Navigate>(() => {});
const useNav = () => useContext(NavContext);

interface AddState {
  specUrl: string;
  setSpecUrl: (v: string) => void;
  preview: SpecPreview | null;
  setPreview: (p: SpecPreview | null) => void;
  loading: boolean;
  setLoading: (v: boolean) => void;
  error: string | null;
  setError: (v: string | null) => void;
  onComplete: () => void;
  onCancel: () => void;
}

const AddStateContext = createContext<AddState>(null!);
const useAddState = () => useContext(AddStateContext);

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function UrlStep() {
  const { specUrl, setSpecUrl, onCancel, setPreview, setLoading, setError, loading } = useAddState();
  const nav = useNav();
  const doPreview = useAtomSet(previewOpenApiSpec, { mode: "promise" });

  const handleNext = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await doPreview({
        path: { scopeId: "default" as never },
        payload: { spec: specUrl },
      });
      setPreview(result);
      nav("/auth");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to parse spec");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          OpenAPI Spec
        </label>
        <textarea
          value={specUrl}
          onChange={(e) => setSpecUrl((e.target as HTMLTextAreaElement).value)}
          placeholder={"https://api.example.com/openapi.json\n\nor paste spec content here..."}
          rows={6}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Paste a URL or the full OpenAPI JSON/YAML content.
        </p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          Cancel
        </button>
        <button
          disabled={!specUrl.trim() || loading}
          onClick={handleNext}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Analyzing…" : "Next"}
        </button>
      </div>
    </div>
  );
}

function AuthStep() {
  const { preview, error: stateError } = useAddState();
  const nav = useNav();

  return (
    <div className="space-y-4">
      {preview && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-medium text-card-foreground">
                {Option.getOrElse(preview.title, () => "API")}
              </p>
              <p className="text-xs text-muted-foreground">
                {Option.getOrElse(preview.version, () => "")} · {preview.operationCount} operations
              </p>
            </div>
          </div>

          {preview.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {preview.tags.slice(0, 10).map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground"
                >
                  {tag}
                </span>
              ))}
              {preview.tags.length > 10 && (
                <span className="text-[10px] text-muted-foreground">
                  +{preview.tags.length - 10} more
                </span>
              )}
            </div>
          )}

          {preview.headerPresets.length > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <p className="text-xs font-medium text-muted-foreground mb-1.5">
                Authentication
              </p>
              {preview.headerPresets.map((p, i) => (
                <div key={i} className="flex items-center gap-2 py-1">
                  <span className="size-1.5 rounded-full bg-primary/50" />
                  <span className="text-xs text-foreground">{p.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {stateError && (
        <p className="text-sm text-destructive">{stateError}</p>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => nav("/")}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          Back
        </button>
        <button
          onClick={() => nav("/confirm")}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function ConfirmStep() {
  const { specUrl, preview, onComplete, setError, error } = useAddState();
  const nav = useNav();
  const [adding, setAdding] = useState(false);
  const doAdd = useAtomSet(addOpenApiSpec, { mode: "promise" });

  const handleAdd = async () => {
    setAdding(true);
    setError(null);
    try {
      await doAdd({
        path: { scopeId: "default" as never },
        payload: { spec: specUrl },
      });
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add source");
      setAdding(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-medium text-card-foreground">Ready to add source</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {preview
            ? `${Option.getOrElse(preview.title, () => "API")} — ${preview.operationCount} operations will be registered as tools.`
            : `Source from: ${specUrl.slice(0, 60)}${specUrl.length > 60 ? "…" : ""}`
          }
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={() => nav("/auth")}
          disabled={adding}
          className="rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          Back
        </button>
        <button
          onClick={handleAdd}
          disabled={adding}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {adding ? "Adding…" : "Add Source"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AddOpenApiSource(props: {
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [specUrl, setSpecUrl] = useState("");
  const [preview, setPreview] = useState<SpecPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const router = useMemo(() => {
    const rootRoute = createRootRoute({
      component: () => (
        <div>
          <h1 className="text-xl font-semibold text-foreground mb-4">Add OpenAPI Source</h1>
          <Outlet />
        </div>
      ),
    });

    const routeTree = rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: "/", component: UrlStep }),
      createRoute({ getParentRoute: () => rootRoute, path: "/auth", component: AuthStep }),
      createRoute({ getParentRoute: () => rootRoute, path: "/confirm", component: ConfirmStep }),
    ]);

    return createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  }, []);

  const navigate: Navigate = (to) => {
    void router.navigate({ to });
  };

  const state: AddState = {
    specUrl, setSpecUrl,
    preview, setPreview,
    loading, setLoading,
    error, setError,
    onComplete: props.onComplete,
    onCancel: props.onCancel,
  };

  return (
    <AddStateContext.Provider value={state}>
      <NavContext.Provider value={navigate}>
        <RouterProvider router={router} />
      </NavContext.Provider>
    </AddStateContext.Provider>
  );
}
