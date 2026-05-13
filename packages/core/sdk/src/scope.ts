import { Schema } from "effect";

import { ScopeId } from "./ids";

export const Scope = Schema.Struct({
  id: ScopeId,
  name: Schema.String,
  createdAt: Schema.Date,
});
export type Scope = typeof Scope.Type;
