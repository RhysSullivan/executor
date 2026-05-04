import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { SlackService } from "../services/slack";
import {
  HttpResponseError,
  isServerError,
  toErrorServerResponse,
} from "./error-response";

const isValidEmail = (s: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

const verifyTurnstile = (token: string, remoteIp: string | null) =>
  Effect.tryPromise({
    try: async () => {
      const secret = env.TURNSTILE_SECRET_KEY;
      if (!secret) {
        // Turnstile is unconfigured — fail closed in prod, but allow dev to
        // boot without it. We treat empty secret as "skip" so the form works
        // before secrets are wired; remove this branch once you've set the
        // secret in every environment.
        return { success: true, skipped: true };
      }
      const form = new URLSearchParams({ secret, response: token });
      if (remoteIp) form.set("remoteip", remoteIp);
      const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: form,
      });
      const json = (await res.json()) as { success: boolean; "error-codes"?: string[] };
      return { success: json.success, errorCodes: json["error-codes"] ?? [] };
    },
    catch: (cause) => ({ success: false as const, fetchError: String(cause) }),
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (request.method !== "POST") {
    return yield* Effect.fail(
      new HttpResponseError({
        status: 405,
        code: "method_not_allowed",
        message: "Method not allowed",
      }),
    );
  }

  const body = (yield* Effect.mapError(
    request.json,
    () =>
      new HttpResponseError({
        status: 400,
        code: "invalid_json",
        message: "Invalid request body",
      }),
  )) as {
    email?: unknown;
    name?: unknown;
    note?: unknown;
    organization?: unknown;
    turnstileToken?: unknown;
  };

  const trimmed = (v: unknown, max: number): string | undefined =>
    typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, max) : undefined;

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const name = trimmed(body.name, 200);
  const note = trimmed(body.note, 2000);
  const organization = trimmed(body.organization, 200);
  const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : "";

  if (!isValidEmail(email)) {
    return yield* Effect.fail(
      new HttpResponseError({
        status: 400,
        code: "invalid_email",
        message: "A valid email is required",
      }),
    );
  }

  if (!turnstileToken) {
    return yield* Effect.fail(
      new HttpResponseError({
        status: 400,
        code: "captcha_required",
        message: "Captcha verification is required.",
      }),
    );
  }

  const remoteIp = request.headers["cf-connecting-ip"] ?? null;
  const verification = yield* verifyTurnstile(turnstileToken, remoteIp);
  if (!verification.success) {
    console.error("[slack] turnstile verification failed:", verification);
    return yield* Effect.fail(
      new HttpResponseError({
        status: 403,
        code: "captcha_failed",
        message: "Captcha verification failed. Please try again.",
      }),
    );
  }

  // Global daily channel-creation cap — bounds the worst case if Turnstile is
  // bypassed somehow. Per-IP gating belongs at the edge (Cloudflare Rules);
  // this binding is a single shared bucket keyed at "global".
  const limit = yield* Effect.tryPromise({
    try: () => env.SLACK_INVITE_LIMITER.limit({ key: "global" }),
    catch: (cause) => ({ success: false as const, fetchError: String(cause) }),
  });
  if (!limit.success) {
    console.error("[slack] global rate limit hit");
    return yield* Effect.fail(
      new HttpResponseError({
        status: 429,
        code: "rate_limited",
        message: "We're getting more contact requests than usual. Please try again later.",
      }),
    );
  }

  const slack = yield* SlackService;
  const { invite } = yield* slack.createConnectInvite({ email, name, note, organization }).pipe(
    Effect.tapError((err) =>
      Effect.sync(() => {
        console.error(`[slack] ${err.method} failed:`, err.error);
      }),
    ),
    Effect.mapError(
      () =>
        new HttpResponseError({
          status: 500,
          code: "slack_invite_failed",
          message: "Couldn't create your Slack invite. Please try again shortly.",
        }),
    ),
  );

  return HttpServerResponse.jsonUnsafe({ url: invite.url }, { status: 200 });
}).pipe(
  Effect.catchCause((err) => {
    if (isServerError(err)) {
      console.error("[slack] request failed:", err instanceof Error ? err.stack : err);
    }
    return Effect.succeed(toErrorServerResponse(err));
  }),
);

export const SlackContactRoutesLive = HttpRouter.add("POST", "/contact/slack", handler);
