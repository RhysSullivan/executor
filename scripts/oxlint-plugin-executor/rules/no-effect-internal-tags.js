import { getPropertyName, getStringValue, unwrapExpression } from "../utils.js";

const effectModules = new Set(["Option", "Either", "Result", "Cause", "Exit"]);
const tagModules = new Map([
  ["Some", ["Option"]],
  ["None", ["Option"]],
  ["Left", ["Either", "Result"]],
  ["Right", ["Either", "Result"]],
  ["Success", ["Exit", "Result"]],
  ["Failure", ["Exit", "Result"]],
  ["Fail", ["Cause"]],
  ["Die", ["Cause"]],
  ["Interrupt", ["Cause"]],
  ["Sequential", ["Cause"]],
  ["Parallel", ["Cause"]],
  ["Then", ["Cause"]],
  ["Both", ["Cause"]],
  ["Empty", ["Cause"]],
]);

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct _tag checks for Effect-owned data types.",
    },
  },
  create(context) {
    const importedEffectModules = new Set();

    return {
      ImportDeclaration(node) {
        for (const moduleName of getImportedEffectModules(node)) {
          importedEffectModules.add(moduleName);
        }
      },
      BinaryExpression(node) {
        if (importedEffectModules.size === 0 || !isEqualityOperator(node.operator)) return;

        reportIfEffectTagComparison(context, importedEffectModules, node.left, node.right);
        reportIfEffectTagComparison(context, importedEffectModules, node.right, node.left);
      },
    };
  },
};

function getImportedEffectModules(node) {
  const moduleName = node.source.value;
  if (typeof moduleName !== "string") return [];

  if (moduleName.startsWith("effect/")) {
    const submodule = moduleName.slice("effect/".length);
    return effectModules.has(submodule) ? [submodule] : [];
  }

  if (moduleName !== "effect") return [];
  return (node.specifiers ?? [])
    .map((specifier) => specifier.imported?.name ?? specifier.imported?.value)
    .filter((name) => effectModules.has(name));
}

function reportIfEffectTagComparison(
  context,
  importedEffectModules,
  accessCandidate,
  tagCandidate,
) {
  const access = getTagAccess(accessCandidate);
  const tag = getStringValue(tagCandidate);
  if (!access || !isEffectTagForImportedModule(tag, importedEffectModules)) return;

  context.report({
    node: access,
    message: `Use Effect's public helpers instead of checking internal _tag "${tag}". Skill: wrdn-effect-typed-errors.`,
  });
}

function isEqualityOperator(operator) {
  return operator === "===" || operator === "!==" || operator === "==" || operator === "!=";
}

function getTagAccess(node) {
  const expression = unwrapExpression(node);
  if (expression?.type !== "MemberExpression") return undefined;

  const name = expression.computed
    ? getStringValue(expression.property)
    : getPropertyName(expression.property);
  return name === "_tag" ? expression : undefined;
}

function isEffectTagForImportedModule(tag, importedEffectModules) {
  if (!tag) return false;
  return tagModules.get(tag)?.some((moduleName) => importedEffectModules.has(moduleName)) ?? false;
}
