# app-cli

Executor CLI thin-client scaffold.

The CLI proxies all operations to an Executor server target:

- `local` target: connects to `http://127.0.0.1:8788` and auto-starts an embedded
  Executor API server subprocess if the local server is not already running.
- `cloud` target: proxies to a configured remote base URL.

Implementation note:

- CLI parsing/help/completion behavior is powered by `@effect/cli`.
- Local CLI server hosting and web API routing both use `@executor-v2/api-http` so
  request/response handling stays in sync.

Supported commands:

- `executor init`
- `executor auth login --client-id ...`
- `executor auth status`
- `executor server start`
- `executor target show`
- `executor target use <local|cloud>`
- `executor workspace current`
- `executor workspace use <workspace-id>`
- `executor run execute --code ...`
- `executor run execute --file ...`
- `executor run resume --run-id ...` (uses cached script from prior execute)
- `executor run resume --run-id ... --file ...` (explicit script)
- `executor run describe`

Control-plane management from CLI should happen through `run execute` and discovered
source tool paths (for example, add Executor's own OpenAPI source, then call its
tool paths to manage other sources).

`run execute` and `run resume` support `--interaction-mode auto|user|agent`:

- `auto` (default): uses `user` for TTY, otherwise `agent`.
- `user`: opens `${baseUrl}/interactions/<workspace>/<interaction>` in browser and waits.
- `agent`: returns a structured `interaction_required` payload and exits with code `20`.

Run locally:

- `bun run --cwd apps/cli start -- target show`
- `bun run --cwd apps/cli start -- run execute --target local --code "return 1"`
- `bun run --cwd apps/cli start -- run describe --target local --workspace ws_local`
- `bun run --cwd apps/cli start -- --help`
- `bun run --cwd apps/cli start -- server start --port 8788`

Seed Executor's own OpenAPI source (example):

- `bun run --cwd apps/cli start -- run execute --target local --workspace ws_local --code "const workspaceId='ws_local'; const res=await fetch('http://127.0.0.1:8788/v1/workspaces/'+workspaceId+'/sources',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'src_executor_openapi',name:'executor:openapi',kind:'openapi',endpoint:'http://127.0.0.1:8788/v1/openapi.json',enabled:true,configJson:JSON.stringify({baseUrl:'http://127.0.0.1:8788'})})}); return await res.json();"`
- Then use `tools.discover(...)` in `run execute` to locate and call source tool paths.
