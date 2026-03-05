import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { signOut } from "@workos-inc/authkit-nextjs";

import { externalOriginFromRequest, isWorkosEnabled } from "../../lib/workos";

export async function GET(request: NextRequest): Promise<Response> {
  if (!isWorkosEnabled()) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  await signOut({
    returnTo: `${externalOriginFromRequest(request)}/`,
  });

  return NextResponse.redirect(new URL("/", request.url));
}
