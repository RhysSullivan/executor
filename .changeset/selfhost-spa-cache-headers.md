---
"@executor-js/host-selfhost": patch
---

Send correct `Cache-Control` headers for the self-hosted web app. The SPA shell (`index.html`) and its client-route fallbacks are now served with `no-cache`, so a new deploy is picked up on the next visit instead of the browser rendering a stale UI from cache until a hard refresh. Content-hashed `/assets/*` are served `immutable` and cached long-term.
