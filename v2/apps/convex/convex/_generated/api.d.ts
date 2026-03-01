/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as controlPlane from "../controlPlane.js";
import type * as control_plane_errors from "../control_plane/errors.js";
import type * as control_plane_http from "../control_plane/http.js";
import type * as control_plane_service from "../control_plane/service.js";
import type * as control_plane_sources from "../control_plane/sources.js";
import type * as credential_resolver from "../credential_resolver.js";
import type * as executor from "../executor.js";
import type * as http from "../http.js";
import type * as mcp from "../mcp.js";
import type * as run_executor from "../run_executor.js";
import type * as runtimeCallbacks from "../runtimeCallbacks.js";
import type * as runtime_adapter from "../runtime_adapter.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  controlPlane: typeof controlPlane;
  "control_plane/errors": typeof control_plane_errors;
  "control_plane/http": typeof control_plane_http;
  "control_plane/service": typeof control_plane_service;
  "control_plane/sources": typeof control_plane_sources;
  credential_resolver: typeof credential_resolver;
  executor: typeof executor;
  http: typeof http;
  mcp: typeof mcp;
  run_executor: typeof run_executor;
  runtimeCallbacks: typeof runtimeCallbacks;
  runtime_adapter: typeof runtime_adapter;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
