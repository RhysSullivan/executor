import type { Skill } from "@executor/plugin-skills";

// Skills shipped by the OpenAPI plugin. Registered into the plugin's
// own `staticSources` (see `plugin.ts`) — NOT passed to the global
// `skillsPlugin`. Living under sourceId `openapi` means the full tool
// id is `openapi.<skill-id>`, right next to `openapi.previewSpec` etc.
// Skill ids therefore omit any `openapi.` prefix; the source id is the
// attachment point.
export const openapiSkills: readonly Skill[] = [
  {
    id: "adding-a-source",
    description:
      "How to add an OpenAPI spec as a source — preview, resolve auth, then addSpec",
    body: `# Adding an OpenAPI source

The full flow to register an OpenAPI document as a source on the current
executor. Three tools, called in order.

## 1. Preview the spec

Call \`openapi.previewSpec\` with the raw spec string (JSON or YAML). You
get back:

- the operations that will be registered as tools
- any security schemes declared in the spec (API key, bearer, OAuth2, …)
- the resolved server base URL

**Why this step:** the preview tells you whether the spec needs
credentials, and which scheme to use. Do not skip it — \`addSpec\` will
fail at invoke time if required auth isn't wired.

## 2. Reference authentication

**Never accept a secret value in-chat.** If an API key, bearer token,
client secret, or password ends up in your context window, it is leaked
— you cannot unsee it, and you must not call \`secrets.set\` with a value
the user typed to you. Your job here is to pick the ids the secrets
will live under and reference them by id in step 3. The user provisions
the actual values out of band (UI / CLI).

Look at the preview's \`securitySchemes\`:

- **API key / bearer** — pick a descriptive id like
  \`\${namespace}-api-key\`. Reference it from \`headers\` in step 3. Tell
  the user to add the secret manually under that id; do not ask them to
  paste it.
- **OAuth2 (authorization code)** — call \`openapi.startOAuth\` with the
  spec and the scheme name. It returns a URL the user opens in the
  browser; the token is captured by \`openapi.completeOAuth\` without
  ever passing through you.
- **OAuth2 (client credentials)** — pick ids for the client id and
  client secret. Reference them in step 3; the invoker mints access
  tokens on demand. Same rule: do not accept the values in-chat.
- **No auth declared** — skip straight to step 3.

## 3. Register the source

Call \`openapi.addSource\` with:

- \`spec\` — the same spec string from step 1
- \`namespace\` — short slug used as the source id (e.g. \`"linear"\`)
- \`baseUrl\` — optional override of the spec's server URL
- \`headers\` — optional static headers, with secret references
  (\`{ "Authorization": { "$secret": "linear-api-key", format: "Bearer {}" } }\`)

On success you get \`{ sourceId, toolCount }\`. Every operation becomes a
tool under \`<namespace>.<operationId>\`, listable via
\`tools.list({ sourceId: namespace })\`.

## Common mistakes

- Calling \`addSpec\` before \`previewSpec\` — you'll miss required auth
  schemes and invocations will 401 later.
- Accepting the secret value from the user in chat and calling
  \`secrets.set\` with it. The value is now in your context. Use the id
  the user provisions out of band; never handle the raw secret.
- Passing the spec URL instead of the spec string — \`addSpec\` expects
  the document body, not a URL. Fetch it first.
`,
  },
];
