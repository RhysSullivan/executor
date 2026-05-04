// ---------------------------------------------------------------------------
// Slack service — creates a per-customer Slack Connect channel and emails an
// invite. Used by the pricing-page "Get in touch on Slack" CTA, modeled on
// WorkOS's onboarding flow.
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Context, Data, Effect, Layer } from "effect";

export class SlackError extends Data.TaggedError("SlackError")<{
  method: string;
  error: string;
}> {}

export type ISlackService = Readonly<{
  createConnectInvite: (input: {
    email: string;
    name?: string;
    note?: string;
    organization?: string;
  }) => Effect.Effect<
    {
      channel: { id: string; name: string };
      invite: { invite_id: string; url: string };
    },
    SlackError
  >;
}>;

const slugifyEmail = (email: string): string =>
  email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const randomSuffix = (): string => {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

type SlackResponse = { ok: boolean; error?: string } & Record<string, unknown>;

const make = Effect.sync(() => {
  const token = env.SLACK_BOT_TOKEN;

  if (!token) {
    const notConfigured = (method: string) =>
      Effect.fail(
        new SlackError({ method, error: "SLACK_BOT_TOKEN is not configured" }),
      );
    return {
      createConnectInvite: () => notConfigured("createConnectInvite"),
    } satisfies ISlackService;
  }

  const call = <A extends SlackResponse>(method: string, body: Record<string, unknown>) =>
    Effect.tryPromise({
      try: async (): Promise<A> => {
        const res = await fetch(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as A;
        if (!json.ok) throw new Error(json.error ?? "unknown_slack_error");
        return json;
      },
      catch: (cause) =>
        new SlackError({
          method,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.withSpan(`slack.${method}`));

  const createConnectInvite: ISlackService["createConnectInvite"] = ({
    email,
    name,
    note,
    organization,
  }) =>
    Effect.gen(function* () {
      // Slack channel names: lowercase, no spaces, max 80 chars, unique per workspace.
      const baseName = `shared-${slugifyEmail(email)}`.slice(0, 80);
      const tryCreate = (n: string) =>
        call<SlackResponse & { channel: { id: string; name: string } }>(
          "conversations.create",
          { name: n, is_private: false },
        );

      const created = yield* tryCreate(baseName).pipe(
        Effect.catchTag("SlackError", (err) =>
          err.error === "name_taken"
            ? tryCreate(`${baseName}-${randomSuffix()}`.slice(0, 80))
            : Effect.fail(err),
        ),
      );
      const channel = created.channel;

      const helloLines = [
        `:wave: New contact from pricing page: ${email}`,
        name ? `Name: ${name}` : null,
        organization ? `Org: ${organization}` : null,
        note ? `Note: ${note}` : null,
      ].filter(Boolean) as string[];

      yield* call<SlackResponse>("chat.postMessage", {
        channel: channel.id,
        text: helloLines.join("\n"),
      });

      const invite = yield* call<SlackResponse & { invite_id: string; url: string }>(
        "conversations.inviteShared",
        {
          channel: channel.id,
          emails: [email],
          // `external_limited: true` scopes the guest to just this channel,
          // which is what we want for a focused 1:1 support conversation.
          external_limited: true,
        },
      );

      return {
        channel: { id: channel.id, name: channel.name },
        invite: { invite_id: invite.invite_id, url: invite.url },
      };
    }).pipe(
      Effect.withSpan("slack.createConnectInvite", { attributes: { "slack.email": email } }),
    );

  return { createConnectInvite } satisfies ISlackService;
});

export class SlackService extends Context.Service<SlackService, ISlackService>()(
  "@executor-js/cloud/SlackService",
) {
  static Default = Layer.effect(this)(make);
}
