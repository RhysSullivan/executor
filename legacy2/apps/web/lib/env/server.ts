import { configSchema, server } from "better-env/config-schema";
import { isTruthy, trim } from "./shared";

const webServerEnvConfig = configSchema("WebServerEnvironment", {
  nodeEnv: server({ env: "NODE_ENV", optional: true }),
  databaseUrl: server({ env: "DATABASE_URL", optional: true }),
  controlPlanePostgresConnectionTarget: server({
    env: "CONTROL_PLANE_POSTGRES_CONNECTION_TARGET",
    optional: true,
  }),
  executorRuntimeKind: server({ env: "EXECUTOR_RUNTIME_KIND", optional: true }),
  legacyPmRuntimeKind: server({ env: "PM_RUNTIME_KIND", optional: true }),
  executorRuntimeRequireToolInteractions: server({
    env: "EXECUTOR_RUNTIME_REQUIRE_TOOL_INTERACTIONS",
    optional: true,
  }),
  executorRuntimeToolExposureMode: server({
    env: "EXECUTOR_RUNTIME_TOOL_EXPOSURE_MODE",
    optional: true,
  }),
  legacyPmToolExposureMode: server({ env: "PM_TOOL_EXPOSURE_MODE", optional: true }),
  cloudflareSandboxCallbackSecret: server({
    env: "CLOUDFLARE_SANDBOX_CALLBACK_SECRET",
    optional: true,
  }),
  executorPublicOrigin: server({ env: "EXECUTOR_PUBLIC_ORIGIN", optional: true }),
  vercelProjectProductionUrl: server({ env: "VERCEL_PROJECT_PRODUCTION_URL", optional: true }),
  vercelUrl: server({ env: "VERCEL_URL", optional: true }),
  workosClientId: server({ env: "WORKOS_CLIENT_ID", optional: true }),
  workosApiKey: server({ env: "WORKOS_API_KEY", optional: true }),
  workosRedirectUri: server({ env: "WORKOS_REDIRECT_URI", optional: true }),
  mcpAuthorizationServer: server({ env: "MCP_AUTHORIZATION_SERVER", optional: true }),
  mcpAuthorizationServerUrl: server({ env: "MCP_AUTHORIZATION_SERVER_URL", optional: true }),
  workosAuthkitIssuer: server({ env: "WORKOS_AUTHKIT_ISSUER", optional: true }),
  workosAuthkitDomain: server({ env: "WORKOS_AUTHKIT_DOMAIN", optional: true }),
  executorAllowLocalMcpOauth: server({
    env: "EXECUTOR_ALLOW_LOCAL_MCP_OAUTH",
    optional: true,
  }),
  controlPlaneSecretMaterialBackend: server({
    env: "CONTROL_PLANE_SECRET_MATERIAL_BACKEND",
    optional: true,
  }),
});

const env = webServerEnvConfig.server;
const executorRuntimeRequireToolInteractionsRaw = trim(env.executorRuntimeRequireToolInteractions);

export const webServerEnvironment = {
  nodeEnv: trim(env.nodeEnv) ?? "development",
  databaseUrl: trim(env.databaseUrl),
  controlPlanePostgresConnectionTarget: trim(env.controlPlanePostgresConnectionTarget)?.toLowerCase(),
  executorRuntimeKind: trim(env.executorRuntimeKind) ?? trim(env.legacyPmRuntimeKind),
  executorRuntimeRequireToolInteractions: isTruthy(executorRuntimeRequireToolInteractionsRaw),
  executorRuntimeToolExposureMode:
    trim(env.executorRuntimeToolExposureMode) ?? trim(env.legacyPmToolExposureMode),
  cloudflareSandboxCallbackSecret: trim(env.cloudflareSandboxCallbackSecret),
  executorPublicOrigin: trim(env.executorPublicOrigin),
  vercelProjectProductionUrl: trim(env.vercelProjectProductionUrl),
  vercelUrl: trim(env.vercelUrl),
  workosClientId: trim(env.workosClientId),
  workosApiKey: trim(env.workosApiKey),
  workosRedirectUri: trim(env.workosRedirectUri),
  mcpAuthorizationServer: trim(env.mcpAuthorizationServer),
  mcpAuthorizationServerUrl: trim(env.mcpAuthorizationServerUrl),
  workosAuthkitIssuer: trim(env.workosAuthkitIssuer),
  workosAuthkitDomain: trim(env.workosAuthkitDomain),
  executorAllowLocalMcpOauth: isTruthy(env.executorAllowLocalMcpOauth),
  controlPlaneSecretMaterialBackend: trim(env.controlPlaneSecretMaterialBackend),
};
