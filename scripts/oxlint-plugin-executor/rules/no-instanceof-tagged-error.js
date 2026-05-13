import { isIdentifier, nodeName } from "../utils.js";

const message =
  "Do not use instanceof for tagged errors. Use Effect.catchTag, Effect.catchTags, or a _tag-based guard. Skill: wrdn-effect-typed-errors.";

const looksLikeTaggedErrorName = (name) =>
  typeof name === "string" && name !== "Error" && name.endsWith("Error");

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== "instanceof") return;
        const rightName = nodeName(node.right);
        if (isIdentifier(node.right) && looksLikeTaggedErrorName(rightName)) {
          context.report({ node, message });
        }
      },
    };
  },
};
