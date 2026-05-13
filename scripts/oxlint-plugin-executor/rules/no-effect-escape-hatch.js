import { getPropertyName, isTestLike, unwrapExpression } from "../utils.js";

const escapeHatches = new Set(["die", "dieMessage", "orDie", "orDieWith"]);

const message =
  "Do not collapse Effect failures with die/orDie escape hatches. Keep typed errors in the Effect error channel; at true runtime edges use a narrow boundary suppression. Skill: wrdn-effect-typed-errors.";

const isEffectEscapeHatch = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "MemberExpression") return false;
  const property = getPropertyName(expression.property);
  return escapeHatches.has(property);
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect die/orDie escape hatches outside test code.",
    },
  },
  create(context) {
    if (isTestLike(context.filename)) return {};

    return {
      MemberExpression(node) {
        if (isEffectEscapeHatch(node)) {
          context.report({ node, message });
        }
      },
    };
  },
};
