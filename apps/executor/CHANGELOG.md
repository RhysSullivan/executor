# executor

## 1.2.4-beta.9

### Patch Changes

- 44ce032: Avoid ever building a full schema workspace catalog during tool description, and resolve schemaful tool details through direct one-tool lookup instead.

## 1.2.4-beta.8

### Patch Changes

- 5617247: Prewarm the lean workspace source index at startup and reuse it across discovery requests so the first tool search no longer pays the full catalog hydration cost.

## 1.2.4-beta.7

### Patch Changes

- 1f82a22: Avoid generating source tool type previews when building namespace metadata, and cap MCP execute help examples to five tools per source.

## 1.2.4-beta.6

### Patch Changes

- 839dcb6: Make `executor up` output more helpful and less debug-oriented.

## 1.2.4-beta.5

### Patch Changes

- 5e3cb3e: Add GitHub source support, migrate legacy executor state on load, and fix execute-path runtime regressions.

## 1.2.4-beta.4

### Patch Changes

- ec5e3a3: Fix Google Discovery tool execution for sources stored with discovery document endpoints

## 1.2.4-beta.3

### Patch Changes

- dc94998: Auto migrate sources on startup

## 1.2.4-beta.2

### Patch Changes

- f0a3802: Fix legacy format parsing

## 1.2.4-beta.1

### Patch Changes

- 5869ddb: Fix build

## 1.2.4-beta.0

### Patch Changes

- 74185a9: Move execution to adapters rather than IR model

## 1.2.3

### Patch Changes

- eda1217: Always request maximal scope for Google Apis

## 1.2.2

### Patch Changes

- 661ed29: Support selecting runtime

## 1.2.1

### Patch Changes

- 329cc41: fix migration
- 86d4d4d: package the PGlite runtime assets in the published CLI bundle

## 1.2.0

### Minor Changes

- 7574535: add multiple sources at same time

### Patch Changes

- a2ada62: Google workspace support, folder based config
  - @executor/codemode-core@null
  - @executor/control-plane@null
  - @executor/executor-mcp@null
  - @executor/server@null

## 1.2.0-beta.7

### Minor Changes

- 7574535: add multiple sources at same time

## 1.1.10-beta.6

### Patch Changes

- a2ada62: Google workspace support, folder based config
