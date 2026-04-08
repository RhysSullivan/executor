// ---------------------------------------------------------------------------
// WorkOS AuthKit — Effect-native sealed session management
// ---------------------------------------------------------------------------

import { Context, Effect, Layer } from "effect";
import { WorkOS } from "@workos-inc/node";
import { WorkOSError } from "./errors";

const COOKIE_NAME = "wos-session";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------


const make = Effect.gen(function* () {
  const apiKey = process.env.WORKOS_API_KEY!;
  const clientId = process.env.WORKOS_CLIENT_ID!;
  const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD!;

  if (!cookiePassword || cookiePassword.length < 32) {
    return yield* Effect.die(new Error("WORKOS_COOKIE_PASSWORD must be at least 32 characters"));
  }

  const workos = new WorkOS(apiKey, { clientId });

  const use = <A>(fn: (wos: WorkOS) => Promise<A>) =>
    Effect.tryPromise({
      try: () => fn(workos),
      catch: (cause) => new WorkOSError({ cause }),
    }).pipe(Effect.withSpan("workos"));

  return {
    getAuthorizationUrl: (redirectUri: string) =>
      workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        redirectUri,
        clientId,
      }),

    authenticateWithCode: (code: string) =>
      use((wos) =>
        wos.userManagement.authenticateWithCode({
          code,
          clientId,
          session: { sealSession: true, cookiePassword },
        }),
      ),

    authenticateRequest: (request: Request) =>
      Effect.gen(function* () {
        const sessionData = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
        if (!sessionData) return null;

        const session = workos.userManagement.loadSealedSession({
          sessionData,
          cookiePassword,
        });

        const result = yield* use((wos) => session.authenticate());

        if (result.authenticated) {
          return {
            userId: result.user.id,
            email: result.user.email,
            firstName: result.user.firstName,
            lastName: result.user.lastName,
            avatarUrl: result.user.profilePictureUrl,
            sessionId: result.sessionId,
            refreshedSession: undefined as string | undefined,
          };
        }

        if (result.reason === "no_session_cookie_provided") return null;

        // Try refreshing
        const refreshed = yield* use((wos) => session.refresh()).pipe(
          Effect.orElseSucceed(() => ({ authenticated: false as const })),
        );

        if (!refreshed.authenticated || !("sealedSession" in refreshed) || !refreshed.sealedSession) return null;

        return {
          userId: refreshed.user.id,
          email: refreshed.user.email,
          firstName: refreshed.user.firstName,
          lastName: refreshed.user.lastName,
          avatarUrl: refreshed.user.profilePictureUrl,
          sessionId: refreshed.sessionId,
          refreshedSession: refreshed.sealedSession,
        };
      }),
  };
});

type WorkOSAuthService = Effect.Effect.Success<typeof make>;

export class WorkOSAuth extends Context.Tag("@executor/cloud/WorkOSAuth")<
  WorkOSAuth,
  WorkOSAuthService
>() {
  static Default = Layer.effect(this, make).pipe(
    Layer.annotateSpans({ module: "WorkOSAuth" }),
  );
}

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.slice(name.length + 1) || null;
};
