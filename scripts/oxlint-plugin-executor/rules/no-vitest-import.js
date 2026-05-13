import { isConfigOrTooling } from "../utils.js";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require test helpers to come from @effect/vitest.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "vitest") return;
        if (isConfigOrTooling(context.filename)) return;
        context.report({
          node: node.source,
          message:
            "Import test helpers from @effect/vitest or @effect/vitest/utils instead of vitest. Skill: wrdn-effect-vitest-tests.",
        });
      },
    };
  },
};
