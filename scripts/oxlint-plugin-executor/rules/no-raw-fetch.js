import {
  getPropertyName,
  isDeclarationFile,
  isIdentifier,
  toRepoRelative,
  unwrapExpression,
} from "../utils.js";

const message =
  "Do not call raw fetch in core/plugin code. Route HTTP through Effect HttpClient or an explicit package-local boundary. Skill: wrdn-effect-raw-fetch-boundary.";

const checkedPrefixes = [
  "packages/core/sdk/src/",
  "packages/plugins/graphql/src/",
  "packages/plugins/mcp/src/",
  "packages/plugins/openapi/src/",
];

const shouldCheck = (filename) => {
  const normalized = toRepoRelative(filename);
  if (isDeclarationFile(filename)) return false;
  return checkedPrefixes.some((prefix) => normalized.startsWith(prefix));
};

const isGlobalFetchMember = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "MemberExpression") return false;
  const object = unwrapExpression(expression.object);
  const property = getPropertyName(expression.property);
  return (
    property === "fetch" &&
    (isIdentifier(object, "globalThis") ||
      isIdentifier(object, "window") ||
      isIdentifier(object, "self"))
  );
};

const isBareFetchCall = (node) => isIdentifier(unwrapExpression(node), "fetch");

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow raw fetch outside approved Effect HTTP boundaries.",
    },
  },
  create(context) {
    if (!shouldCheck(context.filename)) return {};

    return {
      CallExpression(node) {
        if (isBareFetchCall(node.callee) || isGlobalFetchMember(node.callee)) {
          context.report({ node: node.callee, message });
        }
      },
      MemberExpression(node) {
        if (node.parent?.type === "CallExpression" && node.parent.callee === node) return;
        if (isGlobalFetchMember(node)) {
          context.report({ node, message });
        }
      },
    };
  },
};
