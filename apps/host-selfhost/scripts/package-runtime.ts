import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const out = join(root, ".selfhost-runtime");
const serverOut = join(out, "apps/host-selfhost/dist-server");
const requireFromSelfHost = createRequire(join(root, "apps/host-selfhost/package.json"));

const externalPackages = [
  "quickjs-emscripten",
  "quickjs-emscripten-core",
  "@jitl/quickjs-ffi-types",
  "@jitl/quickjs-wasmfile-release-sync",
  "@jitl/quickjs-wasmfile-debug-sync",
  "@jitl/quickjs-wasmfile-release-asyncify",
  "@jitl/quickjs-wasmfile-debug-asyncify",
  "@libsql/linux-x64-gnu",
] as const;

const quickJsExternals = externalPackages.filter(
  (name) => name === "quickjs-emscripten" || name.startsWith("@jitl/"),
);

const packageDir = (name: string): string => {
  const packageJson = requireFromSelfHost.resolve(`${name}/package.json`, {
    paths: [join(root, "node_modules/.bun/node_modules")],
  });
  return dirname(packageJson);
};

const copyPackage = (name: string): void => {
  const destination = join(out, "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(packageDir(name), destination, { recursive: true, dereference: true });
};

rmSync(out, { recursive: true, force: true });
mkdirSync(serverOut, { recursive: true });

await Bun.$`bun build apps/host-selfhost/src/serve.ts --target=bun --format=esm --outdir=${serverOut} ${quickJsExternals.map((name) => `--external=${name}`)}`;

for (const name of externalPackages) copyPackage(name);

if (!existsSync(join(serverOut, "serve.js"))) {
  throw new Error(
    "Expected bundled self-host server at .selfhost-runtime/apps/host-selfhost/dist-server/serve.js",
  );
}

console.log(`Packaged self-host runtime into ${out}`);
