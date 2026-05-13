import { isIdentifier } from "../utils.js";

const message =
  "Do not throw raw Error objects in Effect code. Return Effect.fail with a tagged error or assert directly in tests. Skill: wrdn-effect-typed-errors.";

const isNewError = (node) => node?.type === "NewExpression" && isIdentifier(node.callee, "Error");

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    return {
      ThrowStatement(node) {
        if (isNewError(node.argument)) {
          context.report({ node, message });
        }
      },
    };
  },
};
