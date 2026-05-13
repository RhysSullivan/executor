---
name: wrdn-package-boundaries
description: Preserve workspace package boundaries. Use when lint flags relative imports that cross package roots.
allowed-tools: Read Grep Glob Bash
---

Workspace packages should import each other through package exports, not relative paths.

## Fix Shape

- Replace cross-package relative imports with the target package name.
- If the needed module is not exported, add the smallest package export that matches the package's public surface.
- Keep relative imports only within the same package root.
- Do not reach into another package's private source tree from an app or package.

## Good

```ts
import { createExecutor } from "@executor-js/sdk";
```

## Bad

```ts
import { createExecutor } from "../../../core/sdk/src";
```
