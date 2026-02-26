import { httpRouter } from "convex/server";
import { mcpHandler } from "./mcp";
import { handleToolCallHttp } from "./runtimeCallbacks";

const http = httpRouter();

http.route({ path: "/mcp", method: "POST", handler: mcpHandler });
http.route({ path: "/mcp", method: "GET", handler: mcpHandler });
http.route({ path: "/mcp", method: "DELETE", handler: mcpHandler });
http.route({ path: "/v1/mcp", method: "POST", handler: mcpHandler });
http.route({ path: "/v1/mcp", method: "GET", handler: mcpHandler });
http.route({ path: "/v1/mcp", method: "DELETE", handler: mcpHandler });
http.route({
  path: "/runtime/tool-call",
  method: "POST",
  handler: handleToolCallHttp,
});
http.route({
  path: "/v1/runtime/tool-call",
  method: "POST",
  handler: handleToolCallHttp,
});

export default http;
