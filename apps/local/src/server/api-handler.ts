import { getServerHandlers } from "./main";

export const handleApiRequest = async (request: Request): Promise<Response> => {
  const handlers = await getServerHandlers();
  // Strip /api prefix — Start request middleware forwards /api/* here,
  // but the Effect handler endpoints are defined without the prefix.
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api/, "");
  return handlers.api.handler(new Request(url, request));
};

export const handleMcpRequest = async (request: Request): Promise<Response> => {
  const handlers = await getServerHandlers();
  return handlers.mcp.handleRequest(request);
};
