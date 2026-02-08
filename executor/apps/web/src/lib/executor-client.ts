import { treaty } from "@elysiajs/eden";
import type { App } from "@executor/server/src/index";

// Eden constructs URLs from base + route path.
// In the browser, use current origin so requests go through Next.js rewrites (/api/* → executor).
// On the server (SSR), hit the executor directly.
export const executor = treaty<App>(
  typeof window !== "undefined" ? window.location.origin : "http://localhost:4001"
);
