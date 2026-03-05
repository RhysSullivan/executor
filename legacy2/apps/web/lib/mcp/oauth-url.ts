import { webServerEnvironment } from "../env/server";

const isLocalHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

const localHttpAllowed = (): boolean =>
  webServerEnvironment.nodeEnv !== "production"
  || webServerEnvironment.executorAllowLocalMcpOauth;

export const parseMcpSourceUrl = (raw: string): URL => {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid MCP source URL");
  }

  if (url.username || url.password) {
    throw new Error("Credentials in MCP source URL are not allowed");
  }

  if (url.protocol === "https:") {
    return url;
  }

  if (url.protocol === "http:" && localHttpAllowed() && isLocalHost(url.hostname.toLowerCase())) {
    return url;
  }

  throw new Error("MCP source URL must use https:// (http://localhost allowed in local dev)");
};
