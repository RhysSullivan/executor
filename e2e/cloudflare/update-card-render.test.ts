// Cloudflare-only: the update card paints on the Cloudflare-served web shell
// (Workers Static Assets + the Worker route). See ../src/update-card-render.ts
// for the shared body.
import { registerUpdateCardRenderScenario } from "../src/update-card-render";

registerUpdateCardRenderScenario(
  "Cloudflare · the web shell sidebar surfaces the update-available card",
);
