import type { Profile, ProfileId } from "@executor-v2/schema";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

export interface ProfileStore {
  getById(id: ProfileId): Effect.Effect<Option.Option<Profile>>;
}
