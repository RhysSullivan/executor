// ---------------------------------------------------------------------------
// @executor-js/plugin-http-source/react — v2 client surface.
//
// The v1 client (http-credentials editor) was built entirely on deleted v1
// concepts: SecretBackedValue, ScopeId, ConfiguredCredentialBinding, secret
// pickers, and `@executor-js/react`'s credential-binding components. In v2 a
// connection IS the credential and the value origin is a single paste / OAuth
// flow / provider reference — there is no per-header secret-binding editor.
//
// The full connection-create UI is owned by the shared `@executor-js/react`
// package (not yet migrated to v2). Until that lands, this module re-exports the
// browser-safe v2 auth-template model so client code can render an http
// integration's auth methods.
// ---------------------------------------------------------------------------

export {
  CREDENTIAL_VARIABLE,
  variable,
  type APIKeyAuthentication,
  type Authentication,
  type AuthenticationTemplateValue,
  type AuthenticationVariable,
  type HttpSourceConfig,
  type HttpSourceIntegration,
} from "../sdk/types";
