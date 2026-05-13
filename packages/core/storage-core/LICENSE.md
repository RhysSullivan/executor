This package contains code vendored from better-auth
(https://github.com/better-auth/better-auth), originally authored by
Bereket Engida and contributors, licensed under MIT.

Modifications were made to remove authentication-specific types and to
adapt the interfaces to the executor project.

Vendored files:

- src/adapter.ts — ported from packages/core/src/db/adapter/index.ts
  and types.ts (DBAdapter interface, Where DSL, CustomAdapter,
  DBAdapterFactoryConfig). Promise → Effect conversion, auth-specific
  model names stripped.
- src/schema.ts — ported from packages/core/src/db/type.ts
  (DBSchema, DBFieldAttribute, InferDB\*).
- src/factory.ts — ported from packages/core/src/db/adapter/factory.ts
  (createAdapterFactory). Promise → Effect. Stripped auth-specific
  concerns: BetterAuthOptions generic, numeric serial ids, joins,
  telemetry spans, logger, plural model resolution. Matches our
  simpler CustomAdapter + DBAdapterFactoryConfig shape.
- src/testing/memory.ts — ported from
  packages/memory-adapter/src/memory-adapter.ts (memoryAdapter).
  Promise → Effect. Piped through our createAdapter.
- storage-drizzle/src/adapter.ts — ported from
  packages/drizzle-adapter/src/drizzle-adapter.ts (drizzleAdapter).
  Promise → Effect. Takes an explicit tables map instead of reading
  db.\_.fullSchema. Piped through our createAdapter.

---

The MIT License (MIT)
Copyright (c) 2024 - present, Bereket Engida

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
