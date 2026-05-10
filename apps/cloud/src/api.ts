import * as Cloudflare from "alchemy/Cloudflare/Workers/Runtime";
import { Context, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";

import { RequestScopedServicesLive } from "./api/layers";
import { makeApiLive } from "./api/router";

const handlers = new WeakMap<
  Env,
  (request: Request, context: Context.Context<Cloudflare.WorkerEnvironment>) => Promise<Response>
>();

export const handleApiRequest = (request: Request, env: Env): Promise<Response> => {
  const existing = handlers.get(env);
  const context = Context.make(Cloudflare.WorkerEnvironment, env);
  if (existing) return existing(request, context);

  const workerEnvLive = Cloudflare.WorkerEnvironment.layer(env);
  const requestScopedLive = RequestScopedServicesLive.pipe(Layer.provide(workerEnvLive));
  const handler = HttpRouter.toWebHandler(
    makeApiLive(requestScopedLive).pipe(Layer.provide(workerEnvLive)),
  ).handler;
  handlers.set(env, handler);
  return handler(request, context);
};
