import { isIdentifier } from "../utils.js";

const message =
  "Do not use JSON.parse in domain code. Parse JSON with Effect Schema, for example Schema.parseJson or Schema.fromJsonString(...). Skill: wrdn-effect-schema-boundaries.";

const isJsonParse = (node) =>
  node?.type === "MemberExpression" &&
  isIdentifier(node.object, "JSON") &&
  isIdentifier(node.property, "parse");

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
        if (isJsonParse(node.callee)) {
          context.report({ node, message });
        }
      },
    };
  },
};
