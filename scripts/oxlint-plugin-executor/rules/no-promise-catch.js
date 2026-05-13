import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const message =
  "Do not use Promise .catch(). Model async failures with Effect.tryPromise and typed Effect error handling. Skill: wrdn-effect-typed-errors.";

const isCatchMember = (node) => {
  const expression = unwrapExpression(node);
  if (isIdentifier(unwrapExpression(expression?.object), "Effect")) return false;
  return (
    expression?.type === "MemberExpression" && getPropertyName(expression.property) === "catch"
  );
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Promise-style .catch() error handling.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (isCatchMember(node.callee)) {
          context.report({ node, message });
        }
      },
    };
  },
};
