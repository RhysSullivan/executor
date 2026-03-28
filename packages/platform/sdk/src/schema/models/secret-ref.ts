import * as Schema from "effect/Schema";
import {
  SecretMaterialIdSchema,
} from "../ids";

export const SecretRefSchema = Schema.Struct({
  secretId: SecretMaterialIdSchema,
});

export type SecretRef = typeof SecretRefSchema.Type;
