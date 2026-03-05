import type { NextRequest } from "next/server";
import { handleAuth } from "@workos-inc/authkit-nextjs";

import { externalOriginFromRequest } from "../../lib/workos";

export async function GET(request: NextRequest): Promise<Response> {
  return handleAuth({
    baseURL: externalOriginFromRequest(request),
    returnPathname: "/",
  })(request);
}
