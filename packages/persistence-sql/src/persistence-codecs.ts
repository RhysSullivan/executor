import {
  ApprovalSchema,
  AuthConnectionSchema,
  AuthMaterialSchema,
  OAuthStateSchema,
  OrganizationMembershipSchema,
  OrganizationSchema,
  PolicySchema,
  ProfileSchema,
  SourceAuthBindingSchema,
  SourceSchema,
  StorageInstanceSchema,
  SyncStateSchema,
  TaskRunSchema,
  ToolArtifactSchema,
  WorkspaceSchema,
} from "@executor-v2/schema";
import * as Schema from "effect/Schema";

type JsonCodec<A> = {
  encode: (value: A) => string;
  decode: (value: string) => A;
};

const makeJsonCodec = <A, I>(schema: Schema.Schema<A, I, never>): JsonCodec<A> => {
  const jsonSchema = Schema.parseJson(schema);

  return {
    encode: Schema.encodeSync(jsonSchema),
    decode: Schema.decodeUnknownSync(jsonSchema),
  };
};

export const ProfileJson = makeJsonCodec(ProfileSchema);
export const OrganizationJson = makeJsonCodec(OrganizationSchema);
export const OrganizationMembershipJson = makeJsonCodec(
  OrganizationMembershipSchema,
);
export const WorkspaceJson = makeJsonCodec(WorkspaceSchema);
export const SourceJson = makeJsonCodec(SourceSchema);
export const ToolArtifactJson = makeJsonCodec(ToolArtifactSchema);
export const AuthConnectionJson = makeJsonCodec(AuthConnectionSchema);
export const SourceAuthBindingJson = makeJsonCodec(
  SourceAuthBindingSchema,
);
export const AuthMaterialJson = makeJsonCodec(AuthMaterialSchema);
export const OAuthStateJson = makeJsonCodec(OAuthStateSchema);
export const PolicyJson = makeJsonCodec(PolicySchema);
export const ApprovalJson = makeJsonCodec(ApprovalSchema);
export const TaskRunJson = makeJsonCodec(TaskRunSchema);
export const StorageInstanceJson = makeJsonCodec(StorageInstanceSchema);
export const SyncStateJson = makeJsonCodec(SyncStateSchema);
