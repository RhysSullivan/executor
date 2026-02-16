import { registerRoutes as registerStripeRoutes } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import { components } from "./_generated/api";
import { authKit } from "./auth";
import { anonymousJwksHandler, anonymousTokenHandler } from "./http/anonymous_auth";
import { mcpAnonymousHandler, mcpHandler } from "./http/mcp_handler";
import {
  oauthAuthorizationServerHandler,
  oauthProtectedResourceHandler,
} from "./http/oauth_handlers";

const http = httpRouter();

authKit.registerRoutes(http);
registerStripeRoutes(http, components.stripe, {
  webhookPath: "/stripe/webhook",
});

http.route({ path: "/mcp", method: "POST", handler: mcpHandler });
http.route({ path: "/mcp", method: "GET", handler: mcpHandler });
http.route({ path: "/mcp", method: "DELETE", handler: mcpHandler });
http.route({ path: "/mcp/anonymous", method: "POST", handler: mcpAnonymousHandler });
http.route({ path: "/mcp/anonymous", method: "GET", handler: mcpAnonymousHandler });
http.route({ path: "/mcp/anonymous", method: "DELETE", handler: mcpAnonymousHandler });

http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: oauthProtectedResourceHandler });
http.route({ path: "/.well-known/oauth-authorization-server", method: "GET", handler: oauthAuthorizationServerHandler });
http.route({ path: "/.well-known/jwks.json", method: "GET", handler: anonymousJwksHandler });
http.route({ path: "/auth/anonymous/token", method: "POST", handler: anonymousTokenHandler });
http.route({ path: "/auth/anonymous/token", method: "GET", handler: anonymousTokenHandler });

export default http;
