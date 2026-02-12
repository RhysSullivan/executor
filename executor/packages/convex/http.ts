import { registerRoutes as registerStripeRoutes } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import { components } from "./_generated/api";
import { authKit } from "./auth";
import { mcpHandler } from "./http/mcp_handler";
import {
  oauthAuthorizationServerHandler,
  oauthAuthorizeHandler,
  oauthJwksHandler,
  oauthProtectedResourceHandler,
  oauthRegisterHandler,
  oauthTokenHandler,
} from "./http/oauth_handlers";

const http = httpRouter();

authKit.registerRoutes(http);
registerStripeRoutes(http, components.stripe, {
  webhookPath: "/stripe/webhook",
});

http.route({ path: "/mcp", method: "POST", handler: mcpHandler });
http.route({ path: "/mcp", method: "GET", handler: mcpHandler });
http.route({ path: "/mcp", method: "DELETE", handler: mcpHandler });

http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: oauthProtectedResourceHandler });
http.route({ path: "/.well-known/oauth-authorization-server", method: "GET", handler: oauthAuthorizationServerHandler });
http.route({ path: "/oauth2/jwks", method: "GET", handler: oauthJwksHandler });
http.route({ path: "/register", method: "POST", handler: oauthRegisterHandler });
http.route({ path: "/authorize", method: "GET", handler: oauthAuthorizeHandler });
http.route({ path: "/token", method: "POST", handler: oauthTokenHandler });

export default http;
