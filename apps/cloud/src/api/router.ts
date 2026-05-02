import { Layer } from "effect";

import { AutumnRoutesLive } from "./autumn";
import {
  NonProtectedApiLive,
  OrgApiLive,
  RouterConfig,
  SharedServices,
} from "./layers";
import { ProtectedApiLive } from "./protected";

// One router. Each sub-API contributes its routes via `HttpApiBuilder.layer`,
// which calls `HttpRouter.use(...)` under the hood. Autumn's catch-all proxy
// is added as a plain `HttpRouter.add` route. They all merge into the same
// routing table; there is no outer-then-inner router stacking.
export const ApiLive = Layer.mergeAll(
  NonProtectedApiLive,
  OrgApiLive,
  ProtectedApiLive,
  AutumnRoutesLive,
).pipe(
  Layer.provideMerge(RouterConfig),
  Layer.provideMerge(SharedServices),
);
