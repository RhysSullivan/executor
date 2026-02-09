import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

function getRedirectUri(request: NextRequest): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const origin = host && proto ? `${proto}://${host}` : request.nextUrl.origin;
  return `${origin}/callback`;
}

export async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!process.env.WORKOS_CLIENT_ID || !process.env.WORKOS_API_KEY || !process.env.WORKOS_COOKIE_PASSWORD) {
    return NextResponse.next();
  }

  const { authkitMiddleware } = await import("@workos-inc/authkit-nextjs");
  const handler = authkitMiddleware({
    redirectUri: getRedirectUri(request),
    middlewareAuth: {
      enabled: false,
      unauthenticatedPaths: ["/", "/sign-in", "/sign-up", "/callback", "/sign-out"],
    },
  });

  return handler(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
