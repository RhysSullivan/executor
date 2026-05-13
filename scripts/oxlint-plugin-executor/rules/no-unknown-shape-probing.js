import { isIdentifier, isStringLiteral } from "../utils.js";

const message =
  "Do not probe unknown object shapes in domain code. Normalize at a boundary with Schema, a typed adapter, or a named guard. Skill: wrdn-effect-schema-boundaries.";

const isReflectGet = (node) =>
  node?.type === "MemberExpression" &&
  isIdentifier(node.object, "Reflect") &&
  isIdentifier(node.property, "get");

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isReflectGet(node.callee)) {
          context.report({ node, message });
        }
      },
      BinaryExpression(node) {
        if (node.operator === "in" && isStringLiteral(node.left)) {
          context.report({ node, message });
        }
      },
    };
  },
};
