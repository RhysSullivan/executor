# OpenAPI Fixtures

Real-world (and a handful of hand-authored) OpenAPI spec documents used by the
compliance test matrix in `../src/sdk/compliance-*.test.ts`. Each fixture is
checked in so the tests stay hermetic — they never hit the network.

## Fixtures

| File | Source | Notes |
|------|--------|-------|
| `petstore.json` | https://petstore3.swagger.io/api/v3/openapi.json | Canonical Swagger Petstore (OpenAPI 3.0.4). Small, well-formed, broad method coverage. |
| `stripe.json` | https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json | Stripe's public OpenAPI 3 spec. Large (~7 MB), stress-tests extraction and $ref handling. |
| `github.json` | https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json | GitHub v3 REST API description. Very large (~12 MB), heavy $ref nesting. |
| `nyt-article-search.json` | https://api.apis.guru/v2/specs/nytimes.com/article_search/1.0.0/openapi.json (from APIs.guru) | Small spec with `apiKey`-in-query security — pins the non-header apiKey path. |
| `cookie-auth.json` | Hand-authored for this repo | Minimal spec declaring `apiKey`-in-cookie security. Real-world cookie-auth specs are rare, so this synthetic fixture keeps the cookie-security extraction path tested. |
| `cloudflare.json` | Shipped separately; covered by `real-specs.test.ts`. | Enormous (~16 MB) spec for general parse/extract budget. |

## Refreshing a fixture

1. Re-download the source URL listed above.
2. Drop the new JSON into this directory with the same filename.
3. Run `bun x vitest run src/sdk/compliance-fixtures.test.ts` from
   `packages/plugins/openapi` to confirm nothing broke.

The thresholds in the fixture tests are deliberately loose (e.g. "more than
200 operations") so they don't fail on minor spec churn. If a refresh
pushes a count below a threshold, raise the eyebrow — don't just lower the
threshold.
