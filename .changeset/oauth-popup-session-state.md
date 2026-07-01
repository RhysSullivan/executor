---
"@executor-js/api": patch
---

Fix self-hosted OAuth popup callbacks failing with "OAuth session expired or not found". When a flow starts from an organization context, the state token is wrapped with the org slug before it is sent to the provider. The shared popup callback now unwraps that state and uses the raw token for both session lookup and popup result correlation, while raw (unwrapped) callback state continues to pass through unchanged.
