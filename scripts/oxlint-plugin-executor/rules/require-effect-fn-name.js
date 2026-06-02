import { getPropertyName, isIdentifier, isStringLiteral } from "../utils.js";

const message =
  'Effect.fn must be given a span name string, for example Effect.fn("Domain.method")(function* () { ... }). The name becomes the trace span and fiber name. Use Effect.fnUntraced for internal helpers that should not open a span. Skill: effect-source-of-truth.';

// A bare string-literal name (including a no-substitution template) is the
// traced form. Anything else as the first argument — a generator, an arrow, a
// config object, or a missing argument — is an un-named span and is rejected.
const isSpanName = (node) =>
  isStringLiteral(node) || (node?.type === "TemplateLiteral" && node.expressions.length === 0);

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require a string span-name as the first argument to Effect.fn.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee?.type !== "MemberExpression") return;
        if (!isIdentifier(callee.object, "Effect")) return;
        if (getPropertyName(callee.property) !== "fn") return;
        if (!isSpanName(node.arguments?.[0])) {
          context.report({ node, message });
        }
      },
    };
  },
};
