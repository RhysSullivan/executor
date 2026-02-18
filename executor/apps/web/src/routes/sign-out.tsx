import { createFileRoute } from "@tanstack/react-router";
import { getAuthkit } from "@workos/authkit-tanstack-react-start";
import { externalOriginFromRequest } from "@/lib/http/request-origin";
import { redirectResponse } from "@/lib/http/response";

function readSessionIdFromAccessToken(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (!payload) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      sid?: unknown;
    };
    return typeof claims.sid === "string" && claims.sid.length > 0 ? claims.sid : null;
  } catch {
    return null;
  }
}

function applyHeaderBag(headers: Headers, entries: Record<string, string | string[]>) {
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, value);
  }
}

async function handleSignOut(request: Request): Promise<Response> {
  if (!process.env.WORKOS_CLIENT_ID) {
    return redirectResponse("/");
  }

  const authkit = await getAuthkit();
  const session = await authkit.getSession(request);
  if (!session) {
    return redirectResponse("/");
  }

  const sessionId = readSessionIdFromAccessToken(session.accessToken);
  if (!sessionId) {
    return redirectResponse("/");
  }

  const signedOut = await authkit.signOut(sessionId, {
    returnTo: `${externalOriginFromRequest(request)}/`,
  });

  const headers = new Headers();
  if (signedOut.headers) {
    applyHeaderBag(headers, signedOut.headers);
  }

  return redirectResponse(signedOut.logoutUrl, 302, headers);
}

export const Route = createFileRoute("/sign-out")({
  server: {
    handlers: {
      GET: ({ request }) => handleSignOut(request),
    },
  },
});
