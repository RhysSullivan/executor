import {
  ANONYMOUS_AUTH_AUDIENCE,
  getAnonymousAuthIssuer,
  getAnonymousAuthJwksUrl,
} from "./auth/anonymous";

const rawClientId = process.env.WORKOS_CLIENT_ID?.trim();
const clientId = rawClientId && rawClientId !== "disabled" ? rawClientId : undefined;
const anonymousAuthIssuer = getAnonymousAuthIssuer();
const anonymousAuthJwksUrl = getAnonymousAuthJwksUrl();

const providers = [
  ...(clientId
    ? [
        {
          type: "customJwt" as const,
          issuer: "https://api.workos.com/",
          algorithm: "RS256" as const,
          applicationID: clientId,
          jwks: `https://api.workos.com/sso/jwks/${clientId}`,
        },
        {
          type: "customJwt" as const,
          issuer: `https://api.workos.com/user_management/${clientId}`,
          algorithm: "RS256" as const,
          jwks: `https://api.workos.com/sso/jwks/${clientId}`,
        },
      ]
    : []),
  ...(anonymousAuthIssuer && anonymousAuthJwksUrl
    ? [
        {
          type: "customJwt" as const,
          issuer: anonymousAuthIssuer,
          algorithm: "ES256" as const,
          applicationID: ANONYMOUS_AUTH_AUDIENCE,
          jwks: anonymousAuthJwksUrl,
        },
      ]
    : []),
];

const authConfig = {
  providers,
};

export default authConfig;
