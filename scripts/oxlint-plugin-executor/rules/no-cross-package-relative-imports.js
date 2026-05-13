import fs from "node:fs";
import path from "node:path";

import { repoRoot } from "../utils.js";

const packageRoots = collectPackageRoots().sort((a, b) => b.root.length - a.root.length);

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow relative imports across workspace package boundaries.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const specifier = node.source.value;
        if (typeof specifier !== "string" || !specifier.startsWith(".")) return;

        const target = getCrossPackageRelativeImport(context.filename, specifier);
        if (!target) return;

        context.report({
          node: node.source,
          message: `Import ${target.name} via its package export instead of a relative path. Skill: wrdn-package-boundaries.`,
        });
      },
    };
  },
};

function getCrossPackageRelativeImport(filename, specifier) {
  const sourcePackage = findPackageRoot(path.resolve(filename));
  if (!sourcePackage) return undefined;

  const resolved = path.resolve(path.dirname(filename), specifier);
  const targetPackage = findPackageRoot(resolved);
  if (!targetPackage || targetPackage.root === sourcePackage.root) return undefined;

  return targetPackage;
}

function findPackageRoot(absolutePath) {
  const normalized = path.normalize(absolutePath);
  return packageRoots.find(
    (pkg) => normalized === pkg.root || normalized.startsWith(`${pkg.root}${path.sep}`),
  );
}

function collectPackageRoots() {
  const roots = [];
  for (const root of ["packages", "apps", "examples"]) {
    collectPackageRootsFrom(path.join(repoRoot, root), roots);
  }
  return roots;
}

function collectPackageRootsFrom(dir, roots) {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;

    const packageRoot = path.join(dir, entry.name);
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const json = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (typeof json.name === "string") roots.push({ root: packageRoot, name: json.name });
      continue;
    }

    collectPackageRootsFrom(packageRoot, roots);
  }
}
