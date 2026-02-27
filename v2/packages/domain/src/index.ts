export {
  Actor,
  ActorForbiddenError,
  ActorLive,
  ActorUnauthenticatedError,
  makeActor,
  type ActorShape,
  type MakeActorInput,
  type PermissionRequest,
} from "./auth";

export {
  buildCredentialHeaders,
  CredentialResolver,
  CredentialResolverError,
  CredentialResolverNoneLive,
  extractCredentialResolutionContext,
  makeCredentialResolver,
  selectCredentialBinding,
  selectOAuthAccessToken,
  sourceIdFromSourceKey,
  type CredentialResolverShape,
  type ResolvedToolCredentials,
} from "./credential-resolver";

export {
  ToolInvocationService,
  ToolInvocationServiceError,
  ToolInvocationServiceLive,
  makeToolInvocationService,
  type ToolInvocationServiceShape,
} from "./tool-invocation-service";
