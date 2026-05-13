import { HttpRouter } from "effect/unstable/http";

import { ApiLive } from "./api/router";

export const handleApiRequest = HttpRouter.toWebHandler(ApiLive).handler;
