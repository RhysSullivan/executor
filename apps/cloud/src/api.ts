// ---------------------------------------------------------------------------
// Cloud API — protected core API + public auth endpoints
// ---------------------------------------------------------------------------

import {
  HttpApi,
  HttpApiBuilder,
  HttpApiSwagger,
  HttpMiddleware,
  HttpServer,
} from "@effect/platform";
import { Effect, Layer, Scope } from "effect";
import { setCookie } from "@tanstack/react-start/server";

import { addGroup, CoreHandlers, ExecutorService, ExecutionEngineService } from "@executor/api";
import { createExecutionEngine } from "@executor/execution";
import { OpenApiGroup, OpenApiExtensionService, OpenApiHandlers } from "@executor/plugin-openapi/api";
import { McpGroup, McpExtensionService, McpHandlers } from "@executor/plugin-mcp/api";
import {
  GoogleDiscoveryGroup,
  GoogleDiscoveryExtensionService,
  GoogleDiscoveryHandlers,
} from "@executor/plugin-google-discovery/api";
import { GraphqlGroup, GraphqlExtensionService, GraphqlHandlers } from "@executor/plugin-graphql/api";

import { CloudAuthApi, CloudAuthPublicApi } from "./auth/api";
import { AuthContext, UserStoreService } from "./auth/context";
import { CloudAuthHandlers, CloudAuthPublicHandlers } from "./auth/handlers";
import { WorkOSAuth } from "./auth/workos";
import { DbService } from "./services/db";
import { createTeamExecutor } from "./services/executor";

const ProtectedCloudApi = addGroup(OpenApiGroup)
  .add(McpGroup)
  .add(GoogleDiscoveryGroup)
  .add(GraphqlGroup)
  .add(CloudAuthApi);

const PublicCloudApi = HttpApi.make("cloudPublic")
  .add(CloudAuthPublicApi);

const ProtectedCloudApiLive = HttpApiBuilder.api(ProtectedCloudApi).pipe(
  Layer.provide(CoreHandlers),
  Layer.provide(Layer.mergeAll(
    OpenApiHandlers,
    McpHandlers,
    GoogleDiscoveryHandlers,
    GraphqlHandlers,
    CloudAuthHandlers,
  )),
);

const PublicCloudApiLive = HttpApiBuilder.api(PublicCloudApi).pipe(
  Layer.provide(CloudAuthPublicHandlers),
);

const DbLive = DbService.Live;
const UserStoreLive = UserStoreService.Live.pipe(
  Layer.provide(DbLive),
);

const SharedServices = Layer.mergeAll(
  DbLive,
  UserStoreLive,
  WorkOSAuth.Default,
  HttpServer.layerContext,
);

const sharedServicesScope = Effect.runSync(Scope.make());
const SharedServicesMemoized = Effect.runSync(
  Layer.memoize(SharedServices).pipe(
    Scope.extend(sharedServicesScope),
  ),
);

const publicApiHandler = HttpApiBuilder.toWebHandler(
  PublicCloudApiLive.pipe(
    Layer.provideMerge(SharedServicesMemoized),
  ),
  { middleware: HttpMiddleware.logger },
);

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  if (!match) return null;
  return match.slice(name.length + 1) || null;
};

const isPublicPath = (pathname: string): boolean =>
  pathname === "/auth/login" || pathname === "/auth/callback";

const unauthorized = (message: string): Response =>
  Response.json({ error: message }, { status: 401 });

const COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 7,
  secure: process.env.NODE_ENV === "production",
};

const resolveAuth = (request: Request) =>
  Effect.gen(function* () {
    const workos = yield* WorkOSAuth;
    return yield* workos.authenticateRequest(request);
  });

const resolveTeamId = (
  auth: {
    readonly userId: string;
    readonly email: string;
    readonly firstName: string | null | undefined;
    readonly lastName: string | null | undefined;
    readonly avatarUrl: string | null | undefined;
  },
  cookieTeamId: string | null,
) =>
  Effect.gen(function* () {
    if (cookieTeamId) return cookieTeamId;

    const users = yield* UserStoreService;
    const teams = yield* users.use((store) => store.getTeamsForUser(auth.userId));
    if (teams.length > 0) return teams[0]!.teamId;

    const user = yield* users.use((store) =>
      store.upsertUser({
        id: auth.userId,
        email: auth.email,
        name: `${auth.firstName ?? ""} ${auth.lastName ?? ""}`.trim() || undefined,
        avatarUrl: auth.avatarUrl ?? undefined,
      }),
    );

    const team = yield* users.use((store) =>
      store.createTeam(`${user.name ?? user.email}'s Team`),
    );
    yield* users.use((store) => store.addMember(team.id, user.id, "owner"));
    return team.id;
  });

const resolveExecutor = (teamId: string) =>
  Effect.gen(function* () {
    const users = yield* UserStoreService;
    const team = yield* users.use((store) => store.getTeam(teamId));
    const teamName = team?.name ?? "Unknown Team";
    const encryptionKey = process.env.ENCRYPTION_KEY ?? "local-dev-encryption-key";
    return yield* createTeamExecutor(teamId, teamName, encryptionKey);
  });

type ResolvedAuth = Exclude<Effect.Effect.Success<ReturnType<typeof resolveAuth>>, null>;
type TeamExecutor = Effect.Effect.Success<ReturnType<typeof resolveExecutor>>;

const createProtectedHandler = (
  auth: ResolvedAuth,
  teamId: string,
  executor: TeamExecutor,
) => {
  const engine = createExecutionEngine({ executor });

  const requestServices = Layer.mergeAll(
    Layer.succeed(AuthContext, {
      userId: auth.userId,
      teamId,
      email: auth.email,
      name: `${auth.firstName ?? ""} ${auth.lastName ?? ""}`.trim() || null,
      avatarUrl: auth.avatarUrl ?? null,
    }),
    Layer.succeed(ExecutorService, executor),
    Layer.succeed(ExecutionEngineService, engine),
    Layer.succeed(OpenApiExtensionService, executor.openapi),
    Layer.succeed(McpExtensionService, executor.mcp),
    Layer.succeed(GoogleDiscoveryExtensionService, executor.googleDiscovery),
    Layer.succeed(GraphqlExtensionService, executor.graphql),
  );

  return HttpApiBuilder.toWebHandler(
    HttpApiSwagger.layer({ path: "/docs" }).pipe(
      Layer.provideMerge(HttpApiBuilder.middlewareOpenApi()),
      Layer.provideMerge(ProtectedCloudApiLive),
      Layer.provideMerge(requestServices),
      Layer.provideMerge(SharedServicesMemoized),
    ),
    { middleware: HttpMiddleware.logger },
  );
};

const closeExecutor = (executor: TeamExecutor) =>
  executor.close().pipe(
    Effect.orElseSucceed(() => undefined),
  );

type ProtectedHandler = ReturnType<typeof createProtectedHandler>;

const disposeProtectedHandler = (handler: ProtectedHandler) =>
  Effect.promise(() => handler.dispose()).pipe(
    Effect.orElseSucceed(() => undefined),
  );

export const handleApiRequest = async (request: Request): Promise<Response> => {
  const pathname = new URL(request.url).pathname;

  if (isPublicPath(pathname)) {
    return publicApiHandler.handler(request);
  }

  const requestProgram = Effect.gen(function* () {
    const auth = yield* resolveAuth(request);
    if (!auth) return unauthorized("Unauthorized");

    const cookieTeamId = parseCookie(request.headers.get("cookie"), "executor_team");
    const teamId = yield* resolveTeamId(auth, cookieTeamId);

    const executor = yield* Effect.acquireRelease(
      resolveExecutor(teamId),
      closeExecutor,
    );

    const handler = yield* Effect.acquireRelease(
      Effect.sync(() => createProtectedHandler(auth, teamId, executor)),
      disposeProtectedHandler,
    );

    const response = yield* Effect.promise(() => handler.handler(request));

    const refreshedSession = auth.refreshedSession;
    if (refreshedSession) {
      yield* Effect.sync(() => {
        setCookie("wos-session", refreshedSession, COOKIE_OPTIONS);
      });
    }
    if (!cookieTeamId) {
      yield* Effect.sync(() => {
        setCookie("executor_team", teamId, COOKIE_OPTIONS);
      });
    }
    return response;
  });

  return Effect.runPromise(
    requestProgram.pipe(
      Effect.provide(SharedServicesMemoized),
      Effect.scoped,
    ),
  );
};
