import { httpRouter } from "convex/server";
import { mcpHandler } from "./mcp";

const http = httpRouter();

http.route({ path: "/mcp", method: "POST", handler: mcpHandler });
http.route({ path: "/mcp", method: "GET", handler: mcpHandler });
http.route({ path: "/mcp", method: "DELETE", handler: mcpHandler });
http.route({ path: "/v1/mcp", method: "POST", handler: mcpHandler });
http.route({ path: "/v1/mcp", method: "GET", handler: mcpHandler });
http.route({ path: "/v1/mcp", method: "DELETE", handler: mcpHandler });

export default http;
