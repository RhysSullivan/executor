# schema

Canonical Effect schema package scaffold for Executor v2.

Current scaffold includes:
- branded domain IDs (`src/ids.ts`)
- shared enums and primitives (`src/enums.ts`, `src/common.ts`)
- core model schemas in `src/models/*`
- core event envelope schema in `src/models/event-envelope.ts`
- local snapshot/WAL schemas live in `@executor-v2/persistence-local`
