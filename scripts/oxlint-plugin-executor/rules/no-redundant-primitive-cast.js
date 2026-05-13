import { isConfigOrTooling, unwrapExpression } from "../utils.js";

const message =
  "Avoid primitive casts like value as string. Remove redundant casts, or normalize unknown data with Schema/a typed adapter before use. Skill: wrdn-effect-schema-boundaries.";

const primitiveTypes = new Set(["TSStringKeyword", "TSNumberKeyword", "TSBooleanKeyword"]);

const isPrimitiveType = (node) => primitiveTypes.has(node?.type);

const isPossiblyRedundantExpression = (node) => {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "Identifier" ||
    expression?.type === "MemberExpression" ||
    expression?.type === "ChainExpression"
  );
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    if (isConfigOrTooling(context.filename)) return {};

    const check = (node) => {
      if (isPrimitiveType(node.typeAnnotation) && isPossiblyRedundantExpression(node.expression)) {
        context.report({ node, message });
      }
    };

    return {
      TSAsExpression: check,
      TSTypeAssertion: check,
    };
  },
};
