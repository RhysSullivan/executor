# persistence-ports

Persistence port interface scaffold for Executor v2.

Current scaffold includes:
- `ProfileStore` in `src/profiles.ts`
- `SourceStore` in `src/source-store.ts`
- local-only snapshot/WAL state store lives in `@executor-v2/persistence-local`
- `ToolArtifactStore` in `src/tool-artifacts.ts`
