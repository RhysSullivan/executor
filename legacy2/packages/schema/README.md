# schema

Canonical Effect schema package scaffold for Executor v2.

Current scaffold includes:
- branded domain IDs (`src/ids.ts`)
- shared enums and primitives (`src/enums.ts`, `src/common.ts`)
- core model schemas in `src/models/*`
- core event envelope schema in `src/models/event-envelope.ts`
- persistence port error/store contracts are consumed via `@executor-v2/persistence-ports`
