import { getCallName } from "../utils.js";
import { isTestLike } from "../utils.js";

const testRegistrars = new Set(["describe", "it", "test"]);

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow conditional test registration.",
    },
  },
  create(context) {
    if (!isTestLike(context.filename)) return {};

    let conditionalDepth = 0;

    return {
      IfStatement() {
        conditionalDepth++;
      },
      "IfStatement:exit"() {
        conditionalDepth--;
      },
      ConditionalExpression() {
        conditionalDepth++;
      },
      "ConditionalExpression:exit"() {
        conditionalDepth--;
      },
      CallExpression(node) {
        if (conditionalDepth === 0) return;
        const name = getCallName(node.callee);
        if (!testRegistrars.has(name)) return;
        context.report({
          node,
          message:
            "Avoid conditional test registration; use explicit skip helpers or Effect Vitest helpers.",
        });
      },
    };
  },
};
