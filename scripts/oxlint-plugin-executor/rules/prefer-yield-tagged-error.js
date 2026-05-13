import { getPropertyName, isIdentifier } from "../utils.js";

const message =
  "Yield tagged errors directly in Effect.gen instead of yielding Effect.fail(new ErrorType(...)). Skill: wrdn-effect-typed-errors.";

const isEffectFail = (node) =>
  node?.type === "MemberExpression" &&
  isIdentifier(node.object, "Effect") &&
  getPropertyName(node.property) === "fail";

const isTaggedErrorConstruction = (node) =>
  node?.type === "NewExpression" &&
  isIdentifier(node.callee) &&
  node.callee.name !== "Error" &&
  node.callee.name.endsWith("Error");

const isYieldedEffectFailOfTaggedError = (node) =>
  node?.type === "YieldExpression" &&
  node.delegate === true &&
  node.argument?.type === "CallExpression" &&
  isEffectFail(node.argument.callee) &&
  isTaggedErrorConstruction(node.argument.arguments?.[0]);

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    return {
      YieldExpression(node) {
        if (isYieldedEffectFailOfTaggedError(node)) {
          context.report({ node, message });
        }
      },
    };
  },
};
