# @executor-js/plugin-google-discovery

Turn any [Google Discovery API](https://developers.google.com/discovery) (Calendar, Gmail, Drive, Sheets, etc.) into a set of executor tools. Handles the discovery document, OAuth flow, and per-request token binding.

## Install

```sh
bun add @executor-js/sdk @executor-js/plugin-google-discovery
# or
npm install @executor-js/sdk @executor-js/plugin-google-discovery
```

## Usage

```ts
import { createExecutor } from "@executor-js/sdk";
import { googleDiscoveryPlugin } from "@executor-js/plugin-google-discovery";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";

const executor = await createExecutor({
  onElicitation: "accept-all",
  plugins: [fileSecretsPlugin(), googleDiscoveryPlugin()] as const,
});

const scope = executor.scopes[0]!.id;

// Store the OAuth client credentials as secrets first — the plugin
// references them by id at sign-in time so client_id/client_secret never
// live in your config files.
await executor.secrets.set({
  id: "google-client-id",
  name: "Google OAuth Client ID",
  value: process.env.GOOGLE_CLIENT_ID!,
  scope,
});
await executor.secrets.set({
  id: "google-client-secret",
  name: "Google OAuth Client Secret",
  value: process.env.GOOGLE_CLIENT_SECRET!,
  scope,
});

// Mint a Connection through executor.connections.create(...) — usually
// done by the OAuth start/callback flow on your host. For type-safety
// here we declare a placeholder id.
declare const connectionId: string;

await executor.googleDiscovery.addSource({
  scope,
  name: "Google Calendar",
  discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
  namespace: "calendar",
  auth: {
    kind: "oauth2",
    connectionId,
    clientIdSecretId: "google-client-id",
    clientSecretSecretId: "google-client-secret",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
  },
});

const tools = await executor.tools.list();
```

## Using with Effect

If you're building on `@executor-js/sdk/core` (the raw Effect entry), import this plugin from its `/core` subpath instead — it returns the Effect-shaped plugin with `Effect.Effect<...>`-returning methods rather than promisified wrappers:

```ts
import { googleDiscoveryPlugin } from "@executor-js/plugin-google-discovery/core";
```

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/RhysSullivan/executor).

## License

MIT
