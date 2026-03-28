export type McpRemoteTransportValue = "" | "auto" | "streamable-http" | "sse";

export type McpTransportValue = McpRemoteTransportValue | "stdio";

export type McpRemoteTransportFields = {
  transport: McpRemoteTransportValue;
  queryParamsText: string;
  headersText: string;
};

export type McpStdioTransportFields = {
  transport: "stdio";
  command: string;
  argsText: string;
  envText: string;
  cwd: string;
};

export type McpTransportFields =
  | McpRemoteTransportFields
  | McpStdioTransportFields;

export const defaultMcpRemoteTransportFields = (
  transport: McpRemoteTransportValue = "",
): McpRemoteTransportFields => ({
  transport,
  queryParamsText: "",
  headersText: "",
});

export const defaultMcpStdioTransportFields = (
  input?: Partial<Omit<McpStdioTransportFields, "transport">>,
): McpStdioTransportFields => ({
  transport: "stdio",
  command: input?.command ?? "",
  argsText: input?.argsText ?? "",
  envText: input?.envText ?? "",
  cwd: input?.cwd ?? "",
});

export const asMcpRemoteTransportValue = (
  transport: McpTransportValue | null | undefined,
): McpRemoteTransportValue =>
  transport === "stdio" ? "auto" : (transport ?? "");

export const setMcpTransportFieldsTransport = (
  current: McpTransportFields,
  transport: McpTransportValue,
): McpTransportFields => {
  if (transport === "stdio") {
    return current.transport === "stdio"
      ? current
      : defaultMcpStdioTransportFields();
  }

  return current.transport === "stdio"
    ? defaultMcpRemoteTransportFields(transport)
    : {
        ...current,
        transport,
      };
};
