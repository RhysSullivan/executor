import { HttpApi } from "effect/unstable/httpapi";
import { OrgAuth } from "../auth/middleware";
import { OrgApi } from "./api";

/** Org API with org-level auth — requires authenticated session with an org. */
export const OrgHttpApi = HttpApi.make("org").add(OrgApi).middleware(OrgAuth);
