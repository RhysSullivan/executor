import { getPropertyName, isIdentifier, nodeName, unwrapExpression } from "../utils.js";

const stringMessage =
  "Do not stringify unknown errors. Keep typed failures in Effect or normalize at a typed boundary. Skill: wrdn-effect-typed-errors.";
const messagePropertyMessage =
  "Do not read .message from unknown errors. Preserve typed failures with Effect tagged-error handling. Skill: wrdn-effect-typed-errors.";
const destructuredMessage =
  "Do not destructure .message from unknown errors. Preserve typed failures with Effect tagged-error handling. Skill: wrdn-effect-typed-errors.";

const errorLikeNames = new Set(["cause", "e", "err", "error", "reason", "unknownError"]);

const isErrorLikeIdentifier = (node) => {
  const name = nodeName(unwrapExpression(node));
  return errorLikeNames.has(name);
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow common unknown-error string and message normalization patterns.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isIdentifier(unwrapExpression(node.callee), "String")) return;
        if (node.arguments.some(isErrorLikeIdentifier)) {
          context.report({ node, message: stringMessage });
        }
      },
      MemberExpression(node) {
        if (getPropertyName(node.property) !== "message") return;
        if (isErrorLikeIdentifier(node.object)) {
          context.report({ node, message: messagePropertyMessage });
        }
      },
      VariableDeclarator(node) {
        if (node.id?.type !== "ObjectPattern" || !isErrorLikeIdentifier(node.init)) return;
        for (const property of node.id.properties ?? []) {
          if (property.type !== "Property") continue;
          if (getPropertyName(property.key) === "message") {
            context.report({ node: property, message: destructuredMessage });
          }
        }
      },
    };
  },
};
