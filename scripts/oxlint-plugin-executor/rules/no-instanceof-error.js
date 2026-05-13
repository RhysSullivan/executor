import { nodeName } from "../utils.js";

const message =
  "Do not use instanceof Error. Preserve typed failures with Effect tagged-error handling. Skill: wrdn-effect-typed-errors.";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow instanceof Error checks.",
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator === "instanceof" && nodeName(node.right) === "Error") {
          context.report({ node, message });
        }
      },
    };
  },
};
