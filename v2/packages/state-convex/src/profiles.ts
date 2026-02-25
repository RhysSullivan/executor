import type {
  ConfectQueryCtx,
  DocumentFromTable,
} from "@executor-v2/confect";
import { ProfileSchema, type Profile, type ProfileId } from "@executor-v2/schema";
import type { ProfileStore } from "@executor-v2/persistence-ports";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ExecutorConfectTables } from "./schema";

type ProfileDocument = DocumentFromTable<ExecutorConfectTables, "profiles">;

const toProfile = (document: ProfileDocument): Profile => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...profile } = document;
  return Schema.decodeUnknownSync(ProfileSchema)(profile);
};

export const makeConvexProfileStore = (
  ctx: ConfectQueryCtx<ExecutorConfectTables>,
): ProfileStore => ({
  getById: (id: ProfileId) =>
    pipe(
      ctx.db
        .query("profiles")
        .withIndex("by_domainId", (q) => q.eq("id", id))
        .unique(),
      Effect.orDie,
      Effect.map(Option.map(toProfile)),
    ),
});
