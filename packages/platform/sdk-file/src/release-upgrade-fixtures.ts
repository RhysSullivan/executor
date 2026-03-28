import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveLocalWorkspaceContext } from "./config";

export const ReleaseWorkspaceFixtureArtifactExpectationSchema = Schema.Literal(
  "readable",
  "cache-miss",
);

export const ReleaseWorkspaceFixtureManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("release-workspace"),
  id: Schema.String,
  releaseVersion: Schema.String,
  sourceId: Schema.String,
  artifactExpectation: ReleaseWorkspaceFixtureArtifactExpectationSchema,
  description: Schema.optional(Schema.String),
});

export type ReleaseWorkspaceFixtureManifest =
  typeof ReleaseWorkspaceFixtureManifestSchema.Type;

export type ReleaseWorkspaceFixture = ReleaseWorkspaceFixtureManifest & {
  readonly rootDirectory: string;
};

export const releaseWorkspaceFixturesRoot = fileURLToPath(
  new URL("../../sdk/src/runtime/__fixtures__", import.meta.url),
);

const decodeReleaseWorkspaceFixtureManifest = Schema.decodeUnknownSync(
  Schema.parseJson(ReleaseWorkspaceFixtureManifestSchema),
);

const sanitizeFixtureSegment = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const defaultReleaseWorkspaceFixtureDirectoryName = (input: {
  releaseVersion: string;
  sourceId: string;
}): string =>
  `${sanitizeFixtureSegment(input.releaseVersion)}-${sanitizeFixtureSegment(input.sourceId)}-workspace`;

const loadReleaseWorkspaceFixtures = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(releaseWorkspaceFixturesRoot);
    const fixtures: ReleaseWorkspaceFixture[] = [];

    for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
      const rootDirectory = join(releaseWorkspaceFixturesRoot, entry);
      const info = yield* fs.stat(rootDirectory);
      if (info.type !== "Directory") {
        continue;
      }

      const manifestPath = join(rootDirectory, "fixture.json");
      const exists = yield* fs.exists(manifestPath);
      if (!exists) {
        continue;
      }

      const manifest = decodeReleaseWorkspaceFixtureManifest(
        yield* fs.readFileString(manifestPath, "utf8"),
      );
      fixtures.push({ ...manifest, rootDirectory });
    }

    return fixtures.sort(
      (left, right) =>
        left.releaseVersion.localeCompare(right.releaseVersion) ||
        left.id.localeCompare(right.id),
    );
  });

export const releaseWorkspaceFixtures: readonly ReleaseWorkspaceFixture[] =
  Effect.runSync(
    loadReleaseWorkspaceFixtures().pipe(
      Effect.provide(NodeFileSystem.layer),
      Effect.orDie,
    ),
  );

export const resolveReleaseWorkspaceFixtureContext = (
  fixture: ReleaseWorkspaceFixture,
) =>
  resolveLocalWorkspaceContext({
    workspaceRoot: fixture.rootDirectory,
    homeConfigPath: join(fixture.rootDirectory, ".executor-home.jsonc"),
    homeStateDirectory: join(fixture.rootDirectory, ".executor-home-state"),
  });
