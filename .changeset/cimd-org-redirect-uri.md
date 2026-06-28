---
"@executor-js/api": patch
---

Fix OAuth "Mismatching redirect URI" for org-scoped client-id metadata documents

Org-scoped client-id metadata documents registered their callback as
`redirect_uri` with an `executor_org` query param, but the client always sends
the bare callback and the org is carried in the OAuth `state`. Providers that
compare `redirect_uri` as an exact string (such as PostHog) rejected the
authorize request. Org targets now keep their distinct `client_id` URL but
register the same bare callback `redirect_uri` as every other target.
