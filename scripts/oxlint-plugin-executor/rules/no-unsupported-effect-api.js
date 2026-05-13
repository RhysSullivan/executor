import { getPropertyName, isIdentifier } from "../utils.js";

const unsupported = new Map([
  [
    "async",
    "Effect.async is not available in this repo's Effect runtime. Use Effect.callback for callback adapters.",
  ],
  [
    "zipRight",
    "Effect.zipRight is not available in this repo's Effect runtime. Use Effect.andThen or Effect.gen sequencing.",
  ],
  [
    "timeoutFail",
    "Effect.timeoutFail is not available in this repo's Effect runtime. Use Effect.timeoutOrElse or Effect.timeoutOption.",
  ],
]);

const message = (name) => `${unsupported.get(name)} Skill: wrdn-effect-typed-errors.`;

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect APIs that are not available in this repo's Effect runtime.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (!isIdentifier(node.object, "Effect")) return;
        const property = getPropertyName(node.property);
        if (!unsupported.has(property)) return;
        context.report({ node, message: message(property) });
      },
    };
  },
};
