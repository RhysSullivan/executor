import { describe, expect, it } from "vitest";

import type { GoogleDiscoveryStoredSource } from "./binding-store";
import { collectGoogleDiscoverySecretIds } from "./secret-usage";

describe("collectGoogleDiscoverySecretIds", () => {
  it("collects oauth2 secret ids", () => {
    const source: GoogleDiscoveryStoredSource = {
      namespace: "google_calendar",
      scope: "org_test",
      name: "Google Calendar",
      config: {
        name: "Google Calendar",
        discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest",
        service: "calendar",
        version: "v3",
        rootUrl: "https://www.googleapis.com/",
        servicePath: "calendar/v3/",
        auth: {
          kind: "oauth2",
          clientIdSecretId: "client_id_secret",
          clientSecretSecretId: "client_secret_secret",
          accessTokenSecretId: "access_token_secret",
          refreshTokenSecretId: "refresh_token_secret",
          tokenType: "Bearer",
          expiresAt: null,
          scope: null,
          scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
        },
      },
    };

    expect(collectGoogleDiscoverySecretIds(source)).toEqual([
      "client_id_secret",
      "client_secret_secret",
      "access_token_secret",
      "refresh_token_secret",
    ]);
  });
});
