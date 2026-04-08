import { createMiddleware, createStart } from "@tanstack/react-start";

const serverRequestMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      const { handleApiRequest } = await import("./server/api-handler");
      return handleApiRequest(request);
    }
    if (pathname === "/mcp" || pathname.startsWith("/mcp/")) {
      const { handleMcpRequest } = await import("./server/api-handler");
      return handleMcpRequest(request);
    }
    return next();
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [serverRequestMiddleware],
}));
