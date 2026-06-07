import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { InternalError, IntegrationAlreadyExistsError } from "@executor-js/sdk/shared";

import { GraphqlIntrospectionError, GraphqlExtractionError } from "../sdk/errors";
import { AuthTemplate } from "../sdk/types";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const IntegrationParams = {
  slug: Schema.String,
};

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const AddIntegrationPayload = Schema.Struct({
  slug: Schema.String,
  endpoint: Schema.String,
  description: Schema.optional(Schema.String),
  introspectionJson: Schema.optional(Schema.String),
  authentication: Schema.optional(Schema.Array(AuthTemplate)),
  introspectionHeaders: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const AddIntegrationResponse = Schema.Struct({
  slug: Schema.String,
  toolCount: Schema.Number,
});

const GetIntegrationResponse = Schema.NullOr(
  Schema.Struct({
    slug: Schema.String,
    description: Schema.String,
    kind: Schema.String,
    canRemove: Schema.Boolean,
    canRefresh: Schema.Boolean,
    config: Schema.NullOr(Schema.Unknown),
  }),
);

// ---------------------------------------------------------------------------
// Errors with HTTP status
// ---------------------------------------------------------------------------

const IntrospectionError = GraphqlIntrospectionError.annotate({ httpApiStatus: 400 });
const ExtractionError = GraphqlExtractionError.annotate({ httpApiStatus: 400 });

const GraphqlErrors = [
  InternalError,
  IntrospectionError,
  ExtractionError,
  IntegrationAlreadyExistsError,
] as const;

// ---------------------------------------------------------------------------
// Group — addIntegration / getIntegration over the v2 integration catalog.
// (v1's scope-keyed addSource/getSource is replaced by catalog-keyed routes;
// connections are managed through the core connections API, not here.)
// ---------------------------------------------------------------------------

export const GraphqlGroup = HttpApiGroup.make("graphql-greenfield")
  .add(
    HttpApiEndpoint.post("addIntegration", "/graphql-greenfield/integrations", {
      payload: AddIntegrationPayload,
      success: AddIntegrationResponse,
      error: GraphqlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getIntegration", "/graphql-greenfield/integrations/:slug", {
      params: IntegrationParams,
      success: GetIntegrationResponse,
      error: GraphqlErrors,
    }),
  );
