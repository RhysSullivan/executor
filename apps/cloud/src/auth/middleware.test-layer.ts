import { Effect, Layer } from "effect";

import { SessionAuth, SessionContext, SessionCookies, type Session } from "./middleware";

export type SessionTestContext = Session;

export const makeSessionTestContext = (
  overrides: Partial<SessionTestContext> = {},
): SessionTestContext => ({
  accountId: "user_1",
  email: "test@example.com",
  name: "Test User",
  avatarUrl: null,
  organizationId: "org_existing_1",
  sealedSession: "test_session",
  refreshedSession: null,
  ...overrides,
});

export const SessionAuthTestLayer = (session: Session = makeSessionTestContext()) =>
  Layer.succeed(SessionAuth)({
    cookie: (httpEffect) =>
      httpEffect.pipe(
        Effect.provideService(SessionContext, session),
        // The session handlers driven via this layer don't assert cookie output;
        // a no-op setter satisfies the SessionCookies the middleware provides.
        Effect.provideService(SessionCookies, { set: () => {} }),
      ),
  });
