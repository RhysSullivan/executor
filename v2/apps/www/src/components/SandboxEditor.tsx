import { useState, useEffect, useRef, useCallback } from "react";
import Editor, { type OnMount, type Monaco } from "@monaco-editor/react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SourceManifestEntry {
  name: string;
  label: string;
  icon: string;
  description: string;
  toolCount: number;
  fileSizeKb: number;
  file: string;
}

interface LoadedSource {
  name: string;
  dts: string;
  disposable?: { dispose(): void };
}

// ---------------------------------------------------------------------------
// Default code shown in the editor
// ---------------------------------------------------------------------------

const DEFAULT_CODE = `// Select sources above to enable autocomplete for real API types.
// Try typing "tools." and see what's available.

const zones = await tools.cloudflare.zones.list_zones({})

const zone = zones.result?.find(z => z.name === "example.com")

if (zone) {
  await tools.cloudflare.dns.create_dns_record({
    zone_id: zone.id,
    type: "A",
    name: "api",
    content: "192.0.2.1",
    proxied: true,
  })
}

const deploys = await tools.vercel.deployments.list_deployments({
  limit: 5,
})

return {
  zone: zone?.name,
  recentDeploys: deploys.deployments?.map(d => ({
    url: d.url,
    state: d.readyState,
  })),
}
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const FALLBACK_MANIFEST: SourceManifestEntry[] = [
  { name: "cloudflare", label: "Cloudflare", icon: "☁", description: "DNS, Workers, R2, KV, Zones, WAF", toolCount: 2603, fileSizeKb: 11196, file: "cloudflare.d.ts" },
  { name: "vercel", label: "Vercel", icon: "▲", description: "Deployments, Domains, Projects", toolCount: 281, fileSizeKb: 2511, file: "vercel.d.ts" },
  { name: "github", label: "GitHub", icon: "⬡", description: "Repos, Issues, Pull Requests, Actions", toolCount: 1079, fileSizeKb: 6301, file: "github.d.ts" },
];

export function SandboxEditor() {
  const [manifest, setManifest] = useState<SourceManifestEntry[]>(FALLBACK_MANIFEST);
  const [selected, setSelected] = useState<Set<string>>(new Set(["cloudflare", "vercel", "github"]));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<Map<string, LoadedSource>>(new Map());
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // Fetch manifest on mount (overrides fallback with real data if available)
  useEffect(() => {
    fetch("/types/manifest.json")
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: SourceManifestEntry[]) => setManifest(data))
      .catch(() => {
        // Keep fallback manifest — editor still shows, just no types loaded
      });
  }, []);

  // Load/unload type definitions when selection changes
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    // Load newly selected sources
    for (const name of selected) {
      if (loaded.has(name) || loading.has(name)) continue;

      const entry = manifest.find((e) => e.name === name);
      if (!entry) continue;

      setLoading((prev) => new Set(prev).add(name));

      fetch(`/types/${entry.file}`)
        .then((r) => r.text())
        .then((dts) => {
          const uri = `file:///types/${name}.d.ts`;
          const disposable =
            monaco.languages.typescript.typescriptDefaults.addExtraLib(
              dts,
              uri,
            );

          setLoaded((prev) => {
            const next = new Map(prev);
            next.set(name, { name, dts, disposable });
            return next;
          });
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        })
        .catch((err) => {
          console.error(`Failed to load types for ${name}:`, err);
          setLoading((prev) => {
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        });
    }

    // Dispose deselected sources
    for (const [name, source] of loaded) {
      if (!selected.has(name)) {
        source.disposable?.dispose();
        setLoaded((prev) => {
          const next = new Map(prev);
          next.delete(name);
          return next;
        });
      }
    }
  }, [selected, manifest, loaded, loading]);

  const toggle = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Configure TypeScript compiler
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      moduleResolution:
        monaco.languages.typescript.ModuleResolutionKind.NodeJs,
      allowNonTsExtensions: true,
      strict: true,
      noEmit: true,
      esModuleInterop: true,
      lib: ["esnext"],
    });

    // Disable built-in lib fetching — we provide our own types
    monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
    });
  };

  const totalTools = manifest
    .filter((s) => selected.has(s.name))
    .reduce((sum, s) => sum + s.toolCount, 0);

  return (
    <div>
      {/* Source toggles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {manifest.map((source) => {
          const isSelected = selected.has(source.name);
          const isLoading = loading.has(source.name);
          const isLoaded = loaded.has(source.name);

          return (
            <button
              key={source.name}
              onClick={() => toggle(source.name)}
              className={`group text-left p-3 rounded-lg border transition-all duration-200 ${
                isSelected
                  ? "border-accent/40 bg-accent/[0.06]"
                  : "border-white/[0.08] bg-white/[0.02] hover:border-white/20"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-base">{source.icon}</span>
                  <span className="font-medium text-sm text-[#f5f5f5]">
                    {source.label}
                  </span>
                  {isLoading && (
                    <span className="w-3 h-3 border-2 border-white/20 border-t-accent rounded-full animate-spin" />
                  )}
                  {isSelected && isLoaded && (
                    <span className="text-[0.6rem] text-green-400/60">
                      ✓
                    </span>
                  )}
                </div>
                <div
                  className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                    isSelected
                      ? "border-accent bg-accent"
                      : "border-white/20 bg-transparent"
                  }`}
                >
                  {isSelected && (
                    <svg
                      className="w-2.5 h-2.5 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </div>
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-xs text-white/40">
                  {source.description}
                </span>
              </div>
              <div className="mt-1 text-[0.6rem] uppercase tracking-widest text-white/25">
                {source.toolCount.toLocaleString()} tools
              </div>
            </button>
          );
        })}
      </div>

      {/* Stats bar */}
      <div className="flex items-center justify-between text-xs text-white/40 mb-3 px-1">
        <span>
          <span className="text-[#f5f5f5] font-medium">{selected.size}</span>{" "}
          source{selected.size !== 1 ? "s" : ""} selected
        </span>
        <span>
          <span className="text-accent font-mono font-medium">
            {totalTools.toLocaleString()}
          </span>{" "}
          typed tools available
        </span>
      </div>

      {/* Monaco Editor */}
      <div className="bg-surface border border-white/[0.06] rounded-lg overflow-hidden">
        <div className="px-4 py-3 bg-white/[0.02] border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[0.65rem] uppercase tracking-widest text-white/30">
              sandbox.ts
            </span>
            <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/30">
              TypeScript
            </span>
          </div>
          <div className="flex items-center gap-2 text-[0.6rem] text-white/25">
            {loading.size > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 border-2 border-white/20 border-t-accent rounded-full animate-spin" />
                Loading types...
              </span>
            )}
            {loading.size === 0 && loaded.size > 0 && (
              <span className="text-green-400/50">Types loaded</span>
            )}
          </div>
        </div>
        <Editor
          height="420px"
          defaultLanguage="typescript"
          defaultValue={DEFAULT_CODE}
          theme="vs-dark"
          onMount={handleMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 24,
            padding: { top: 16, bottom: 16 },
            scrollBeyondLastLine: false,
            wordWrap: "on",
            tabSize: 2,
            automaticLayout: true,
            suggestOnTriggerCharacters: true,
            quickSuggestions: true,
            renderLineHighlight: "none",
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: true,
            scrollbar: {
              verticalScrollbarSize: 6,
              horizontalScrollbarSize: 6,
            },
            fontFamily: "'JetBrains Mono', monospace",
            fontLigatures: true,
          }}
        />
      </div>

      {/* Hint */}
      <div className="mt-4 px-4 py-3 bg-blue-500/[0.05] border-l-2 border-blue-400 text-sm text-white/60">
        These are <span className="text-[#f5f5f5] font-medium">real types</span> generated
        from the actual OpenAPI specs — {totalTools.toLocaleString()} typed tool methods across {selected.size} sources.
        Try typing <code className="text-accent">tools.</code> and using autocomplete.
      </div>
    </div>
  );
}
