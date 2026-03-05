import { AtomHttpApi } from "@effect-atom/atom";
import {
  FetchHttpClient,
  HttpApiClient,
  HttpApiError,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
} from "@effect/platform";
import * as ParseResult from "effect/ParseResult";

import {
  ControlPlaneApi,
  type ControlPlaneBadRequestError,
  type ControlPlaneForbiddenError,
  type ControlPlaneStorageError,
  type ControlPlaneUnauthorizedError,
} from "./api";

export type ControlPlaneClientOptions = {
  baseUrl: string;
  headers?:
    | Readonly<Record<string, string>>
    | (() => Readonly<Record<string, string>> | undefined);
};

export type ControlPlaneClientError =
  | ControlPlaneBadRequestError
  | ControlPlaneUnauthorizedError
  | ControlPlaneForbiddenError
  | ControlPlaneStorageError
  | HttpApiError.HttpApiDecodeError
  | HttpClientError.HttpClientError
  | ParseResult.ParseError;

const makeTransformClient = (headers: ControlPlaneClientOptions["headers"]) =>
  headers === undefined
    ? undefined
    : (client: HttpClient.HttpClient) =>
        HttpClient.mapRequest(client, (request) => {
          const resolvedHeaders =
            typeof headers === "function" ? headers() : headers;

          return resolvedHeaders
            ? HttpClientRequest.setHeaders(request, resolvedHeaders)
            : request;
        });

export const makeControlPlaneClient = (options: ControlPlaneClientOptions) =>
  HttpApiClient.make(ControlPlaneApi, {
    baseUrl: options.baseUrl,
    transformClient: makeTransformClient(options.headers),
  });

export const createControlPlaneAtomClient = (options: ControlPlaneClientOptions) =>
  AtomHttpApi.Tag<unknown>()("@executor-v2/management-api/AtomClient", {
    api: ControlPlaneApi,
    httpClient: FetchHttpClient.layer,
    baseUrl: options.baseUrl,
    transformClient: makeTransformClient(options.headers),
  });

export type ControlPlaneAtomClient = ReturnType<typeof createControlPlaneAtomClient>;
