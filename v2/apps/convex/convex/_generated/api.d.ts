/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as executor from "../executor.js";
import type * as http from "../http.js";
import type * as mcp from "../mcp.js";
import type * as rpc_exit from "../rpc_exit.js";
import type * as run_executor from "../run_executor.js";
import type * as runtimeCallbacks from "../runtimeCallbacks.js";
import type * as runtime_adapter from "../runtime_adapter.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  executor: typeof executor;
  http: typeof http;
  mcp: typeof mcp;
  rpc_exit: typeof rpc_exit;
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
