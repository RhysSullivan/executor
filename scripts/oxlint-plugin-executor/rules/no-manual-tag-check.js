import { isIdentifier, isStringLiteral } from "../utils.js";

const message =
  "Do not inspect _tag manually. Use Effect.catchTag, Effect.catchTags, Predicate.isTagged, or another Effect tagged-error API.";

const isTagProperty = (node) =>
  isIdentifier(node, "_tag") || (isStringLiteral(node) && node.value === "_tag");

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (isTagProperty(node.property)) {
          context.report({ node, message });
        }
      },
    };
  },
};
