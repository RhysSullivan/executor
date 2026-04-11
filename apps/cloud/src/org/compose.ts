import { HttpApi } from "@effect/platform";
import { OrgAuth } from "../auth/middleware";
import { OrgApi } from "./api";

/** Org API with org-level auth — requires authenticated session with an org. */
export const OrgHttpApi = HttpApi.make("org").add(OrgApi).middleware(OrgAuth);
