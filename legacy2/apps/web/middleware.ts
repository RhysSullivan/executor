import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

import { isWorkosEnabled, resolveWorkosRedirectUri } from "./lib/workos";

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  if (!isWorkosEnabled()) {
    return NextResponse.next();
  }

  const redirectUri = resolveWorkosRedirectUri(request);

  return authkitMiddleware(
    redirectUri
      ? {
          redirectUri,
        }
      : undefined,
  )(request, event);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
