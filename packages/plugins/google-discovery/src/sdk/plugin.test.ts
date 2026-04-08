import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  createExecutor,
  makeTestConfig,
  SecretId,
  type InvokeOptions,
} from "@executor/core";
import { googleDiscoveryPlugin } from "./plugin";

const autoApprove: InvokeOptions = { onElicitation: "accept-all" };
const fixturePath = resolve(__dirname, "../../fixtures/drive.json");
const fixtureText = readFileSync(fixturePath, "utf8");

const withGoogleDiscoveryServer = async <T>(
  run: (input: {
    baseUrl: string;
    discoveryUrl: string;
    requests: Array<{
      method: string;
      url: string;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>;
  }) => Promise<T>,
): Promise<T> => {
  const requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const url = request.url ?? "/";

    requests.push({
      method: request.method ?? "GET",
      url,
      headers: request.headers,
      body,
    });

    if (url === "/$discovery/rest?version=v3") {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Failed to resolve test server address");
      }
      const dynamicFixture = JSON.stringify({
        ...JSON.parse(fixtureText),
        rootUrl: `http://127.0.0.1:${address.port}/`,
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(dynamicFixture);
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "123", name: "Quarterly Plan" }));
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve test server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return await run({
      baseUrl,
      discoveryUrl: `${baseUrl}/$discovery/rest?version=v3`,
      requests,
    });
  } finally {
    await new Promise<void>((resolvePromise, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise();
      });
    });
  }
};

describe("Google Discovery plugin", () => {
  it("normalizes legacy googleapis discovery urls", async () => {
    const executor = await Effect.runPromise(
      createExecutor(
        makeTestConfig({
          plugins: [googleDiscoveryPlugin()] as const,
        }),
      ),
    );

    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(((
        input: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest") {
          return Promise.resolve(
            new Response(fixtureText, {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }

        return originalFetch(input, init);
      }) as typeof fetch);

    try {
      const result = await Effect.runPromise(
        executor.googleDiscovery.probeDiscovery(
          "https://drive.googleapis.com/$discovery/rest?version=v3",
        ),
      );

      expect(result.service).toBe("drive");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    } finally {
      fetchMock.mockRestore();
      await Effect.runPromise(executor.close());
    }
  });

  it("starts oauth using discovery scopes", async () => {
    await withGoogleDiscoveryServer(async ({ discoveryUrl }) => {
      const executor = await Effect.runPromise(
        createExecutor(
          makeTestConfig({
            plugins: [googleDiscoveryPlugin()] as const,
          }),
        ),
      );

      const result = await Effect.runPromise(
        executor.googleDiscovery.startOAuth({
          name: "Google Drive",
          discoveryUrl,
          clientId: "client-123",
          redirectUrl: "http://localhost/callback",
        }),
      );

      const authorizationUrl = new URL(result.authorizationUrl);
      expect(result.scopes).toContain("https://www.googleapis.com/auth/drive");
      expect(authorizationUrl.searchParams.get("client_id")).toBe("client-123");
      expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
      expect(authorizationUrl.searchParams.get("prompt")).toBe("consent");

      await Effect.runPromise(executor.close());
    });
  });

  it("completes oauth and stores token secrets", async () => {
    await withGoogleDiscoveryServer(async ({ discoveryUrl }) => {
      const executor = await Effect.runPromise(
        createExecutor(
          makeTestConfig({
            plugins: [googleDiscoveryPlugin()] as const,
          }),
        ),
      );

      await Effect.runPromise(
        executor.secrets.set({
          id: SecretId.make("google-client-secret"),
          name: "Google Client Secret",
          value: "client-secret-value",
          purpose: "google_oauth_client_secret",
        }),
      );

      const originalFetch = globalThis.fetch;
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(((
          input: RequestInfo | URL,
          init?: RequestInit,
        ) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : input.url;
          if (url === "https://oauth2.googleapis.com/token") {
            expect(init?.method).toBe("POST");
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  access_token: "access-token-value",
                  refresh_token: "refresh-token-value",
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: "https://www.googleapis.com/auth/drive",
                }),
                {
                  status: 200,
                  headers: { "content-type": "application/json" },
                },
              ),
            );
          }
          return originalFetch(input, init);
        }) as typeof fetch);

      try {
        const started = await Effect.runPromise(
          executor.googleDiscovery.startOAuth({
            name: "Google Drive",
            discoveryUrl,
            clientId: "client-123",
            clientSecretSecretId: "google-client-secret",
            redirectUrl: "http://localhost/callback",
          }),
        );

        const auth = await Effect.runPromise(
          executor.googleDiscovery.completeOAuth({
            state: started.sessionId,
            code: "code-123",
          }),
        );

        expect(auth.kind).toBe("oauth2");
        expect(auth.clientId).toBe("client-123");
        expect(auth.refreshTokenSecretId).not.toBeNull();

        const accessToken = await Effect.runPromise(
          executor.secrets.resolve(SecretId.make(auth.accessTokenSecretId)),
        );
        const refreshToken = await Effect.runPromise(
          executor.secrets.resolve(SecretId.make(auth.refreshTokenSecretId!)),
        );
        expect(accessToken).toBe("access-token-value");
        expect(refreshToken).toBe("refresh-token-value");
      } finally {
        fetchMock.mockRestore();
        await Effect.runPromise(executor.close());
      }
    });
  });

  it("registers and invokes google discovery tools with oauth headers", async () => {
    await withGoogleDiscoveryServer(async ({ discoveryUrl, requests }) => {
      const executor = await Effect.runPromise(
        createExecutor(
          makeTestConfig({
            plugins: [googleDiscoveryPlugin()] as const,
          }),
        ),
      );

      try {
        await Effect.runPromise(
          executor.secrets.set({
            id: SecretId.make("drive-access-token"),
            name: "Drive Access Token",
            value: "secret-token",
            purpose: "google_oauth_access_token",
          }),
        );

        const result = await Effect.runPromise(
          executor.googleDiscovery.addSource({
            name: "Google Drive",
            discoveryUrl,
            namespace: "drive",
            auth: {
              kind: "oauth2",
              clientId: "client-123",
              clientSecretSecretId: null,
              accessTokenSecretId: "drive-access-token",
              refreshTokenSecretId: null,
              tokenType: "Bearer",
              expiresAt: null,
              scope: null,
              scopes: ["https://www.googleapis.com/auth/drive.readonly"],
            },
          }),
        );

        expect(result.toolCount).toBe(2);

        const invocation = await Effect.runPromise(
          executor.tools.invoke(
            "drive.files.get",
            { fileId: "123", fields: "id,name", prettyPrint: true },
            autoApprove,
          ),
        );

        expect(invocation.error).toBeNull();
        expect(invocation.data).toEqual({
          id: "123",
          name: "Quarterly Plan",
        });

        const apiRequest = requests.find((request) =>
          request.url.startsWith("/drive/v3/files/123"),
        );
        expect(apiRequest).toBeDefined();
        expect(apiRequest!.headers.authorization).toBe("Bearer secret-token");
        expect(apiRequest!.url).toContain("fields=id%2Cname");
        expect(apiRequest!.url).toContain("prettyPrint=true");
      } finally {
        await Effect.runPromise(executor.close());
      }
    });
  });
});
