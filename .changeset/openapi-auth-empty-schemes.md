---
"executor": patch
---

Fix Authentication section in the OpenAPI source-add UI when a spec declares no `security` block and no `components.securitySchemes` (e.g. Microsoft Graph). The static Custom and None radios are now always visible, and the headers list renders by default so users can configure auth manually.
