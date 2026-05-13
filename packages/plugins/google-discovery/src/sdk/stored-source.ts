import { Schema } from "effect";

import { GoogleDiscoveryStoredSourceData } from "./types";

// ---------------------------------------------------------------------------
// Stored source — the shape persisted by the binding store and exposed
// via the getSource HTTP endpoint.
// ---------------------------------------------------------------------------

export const GoogleDiscoveryStoredSourceSchema = Schema.Struct({
  namespace: Schema.String,
  name: Schema.String,
  config: GoogleDiscoveryStoredSourceData,
}).annotate({ identifier: "GoogleDiscoveryStoredSource" });
export type GoogleDiscoveryStoredSourceSchema = typeof GoogleDiscoveryStoredSourceSchema.Type;

export type GoogleDiscoveryStoredSourceSchemaType = typeof GoogleDiscoveryStoredSourceSchema.Type;
