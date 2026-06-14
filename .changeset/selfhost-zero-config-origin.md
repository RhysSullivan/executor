---
"executor": patch
---

Self-hosted instances now detect their public URL automatically on common
platforms. When `EXECUTOR_WEB_BASE_URL` is not set, the server reads the origin
a host injects (Railway, Render, Fly, Vercel, Netlify, Heroku, Azure, and
Cloudflare Pages) instead of defaulting to localhost — so a platform deploy
works with zero configuration and no longer fails sign-in with "Invalid origin".
When the origin still can't be determined, that error is replaced with a clear
message telling you exactly which `EXECUTOR_WEB_BASE_URL` value to set.
