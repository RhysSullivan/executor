export {
  ExecutorFileConfig,
  SourceConfig,
  OpenApiSourceConfig,
  GraphqlSourceConfig,
  McpRemoteSourceConfig,
  McpStdioSourceConfig,
  McpAuthConfig,
  McpConnectionAuth,
  SecretMetadata,
  ConfigHeaderValue,
  SECRET_REF_PREFIX,
} from "./schema";

export { loadConfig, ConfigParseError } from "./load";

export {
  addSourceToConfig,
  removeSourceFromConfig,
  writeConfig,
  addSecretToConfig,
  removeSecretFromConfig,
} from "./write";

export type { ConfigFileSink, ConfigFileSinkOptions } from "./sink";
export { makeFileConfigSink } from "./sink";

export {
  headerToConfigValue,
  headersToConfigValues,
  headerFromConfigValue,
  headersFromConfigValues,
  mcpAuthToConfig,
  mcpAuthFromConfig,
  type PluginHeaderValue,
} from "./transform";
