function readEnvVar(name: string): string | undefined {
  for (const [key, value] of Object.entries(process.env)) {
    if (key === name) {
      return value;
    }
  }
  return undefined;
}

const clientId = readEnvVar("WORKOS_CLIENT_ID");

const authConfig = clientId
  ? {
      providers: [
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
      ],
    }
  : { providers: [] as const };

export default authConfig;
