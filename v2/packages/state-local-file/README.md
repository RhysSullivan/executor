# persistence-local

Local file-backed persistence adapter scaffold for Executor v2.

Current scaffold includes:
- local file `SourceStore` implementation in `src/source-store.ts`
- local-only snapshot/WAL schemas (`src/local-state-snapshot.ts`) and `LocalStateStore` contract (`src/local-state-store.ts`), plus file implementation (`src/state-store.ts`) for `snapshot.json` + `events.jsonl`
- local file `ToolArtifactStore` implementation in `src/tool-artifact-store.ts`
- `LocalSourceStoreLive`, `LocalStateStoreLive`, and `LocalToolArtifactStoreLive` layers for service-first wiring
- Effect Platform `FileSystem` / `Path` integration for file operations
- atomic JSON persistence for sources, snapshot, and tool artifacts
