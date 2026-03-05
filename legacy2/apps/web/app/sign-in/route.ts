import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSignInUrl } from "@workos-inc/authkit-nextjs";

import { isWorkosEnabled, resolveWorkosRedirectUri } from "../../lib/workos";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isWorkosEnabled()) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const redirectUri = resolveWorkosRedirectUri(request);
  if (!redirectUri) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const signInUrl = await getSignInUrl({
    redirectUri,
  });

  return NextResponse.redirect(signInUrl);
}
