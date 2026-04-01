import { Schema } from "effect";

import { ScopeId } from "./ids";

export class Scope extends Schema.Class<Scope>("Scope")({
  id: ScopeId,
  parentId: Schema.NullOr(ScopeId),
  name: Schema.String,
  createdAt: Schema.DateFromNumber,
}) {}
