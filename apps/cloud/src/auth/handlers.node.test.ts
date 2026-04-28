import {
  HttpApiBuilder,
  HttpApp,
  HttpServer,
  HttpApi,
} from "@effect/platform";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { CloudAuthPublicApi } from "./api";
import { CloudAuthPublicHandlers } from "./handlers";
import { UserStoreService } from "./context";
import { WorkOSAuth } from "./workos";

const TestAuthPublicApi = HttpApi.make("cloudWeb").add(CloudAuthPublicApi);

const makeAuthFetch = (workos: Partial<WorkOSAuth["Type"]>) => {
  const WorkOSTest = Layer.succeed(
    WorkOSAuth,
    new Proxy(workos as WorkOSAuth["Type"], {
      get: (target, prop) => {
        if (prop in target) return target[prop as keyof typeof target];
        return () => {
          throw new Error(`WorkOSAuth.${String(prop)} not stubbed`);
        };
      },
    }),
  );
  const UserStoreTest = Layer.succeed(UserStoreService, {
    use: <A>() => Effect.sync(() => undefined as A),
  });
  const app = Effect.flatMap(
    HttpApiBuilder.httpApp.pipe(
      Effect.provide(
        HttpApiBuilder.api(TestAuthPublicApi).pipe(
          Layer.provide(CloudAuthPublicHandlers),
          Layer.provideMerge(WorkOSTest),
          Layer.provideMerge(UserStoreTest),
          Layer.provideMerge(HttpServer.layerContext),
          Layer.provideMerge(HttpApiBuilder.Router.Live),
          Layer.provideMerge(HttpApiBuilder.Middleware.layer),
        ),
      ),
    ),
    (app) => app,
  ).pipe(Effect.provide(HttpServer.layerContext));
  return HttpApp.toWebHandler(app);
};

describe("Auth callback handlers", () => {
  it.effect("routes login", () =>
    Effect.gen(function* () {
      let observedState: string | undefined;
      const fetch = makeAuthFetch({
        getAuthorizationUrl: (_redirectUri, state) => {
          observedState = state;
          return `https://auth.example.test?state=${state}`;
        },
      });
      const response = yield* Effect.promise(() =>
        fetch(new Request("http://test.local/auth/login")),
      );
      expect(response.status).toBe(302);
      expect(observedState).toMatch(/^[0-9a-f]{64}$/);
      expect(response.headers.get("location")).toBe(
        `https://auth.example.test?state=${observedState}`,
      );
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`wos-login-state=${observedState}`);
      expect(setCookie).toContain("Max-Age=600");
    }),
  );

  it.effect("rejects callback state without the matching login state cookie", () =>
    Effect.gen(function* () {
      let authenticateCalls = 0;
      const fetch = makeAuthFetch({
        authenticateWithCode: () =>
          Effect.sync(() => {
            authenticateCalls++;
            return {
              user: { id: "user_1" },
              accessToken: "access_token",
              refreshToken: "refresh_token",
              organizationId: null,
              sealedSession: "sealed_session",
            } as never;
          }),
      });

      const response = yield* Effect.promise(() =>
        fetch(
          new Request("http://test.local/auth/callback?code=attacker-code&state=attacker-state"),
        ),
      );

      expect(response.status).toBe(400);
      expect(authenticateCalls).toBe(0);
    }),
  );

  it.effect("sets the session cookie and clears login state on matching callback state", () =>
    Effect.gen(function* () {
      const fetch = makeAuthFetch({
        authenticateWithCode: () =>
          Effect.succeed({
            user: { id: "user_1" },
            accessToken: "access_token",
            refreshToken: "refresh_token",
            organizationId: "org_1",
            sealedSession: "sealed_session",
          } as never),
      });

      const response = yield* Effect.promise(() =>
        fetch(
          new Request("http://test.local/auth/callback?code=code&state=state_1", {
            headers: { cookie: "wos-login-state=state_1" },
          }),
        ),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/");
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("wos-session=sealed_session");
      expect(setCookie).toContain("Max-Age=604800");
      expect(setCookie).toContain("wos-login-state=");
      expect(setCookie).toContain("Max-Age=0");
    }),
  );
});
