import { isConfigOrTooling } from "../utils.js";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow double casts through unknown or any.",
    },
  },
  create(context) {
    if (isConfigOrTooling(context.filename)) return {};

    return {
      TSAsExpression(node) {
        if (node.expression?.type !== "TSAsExpression") return;
        const innerType = node.expression.typeAnnotation?.type;
        if (innerType !== "TSUnknownKeyword" && innerType !== "TSAnyKeyword") return;
        if (hasAllowComment(context, node)) return;
        context.report({
          node,
          message:
            "Avoid double casts through unknown/any; use a typed boundary, schema decode, or a narrow allow comment with a reason. Skill: wrdn-effect-schema-boundaries.",
        });
      },
    };
  },
};

function hasAllowComment(context, node) {
  const comments = context.sourceCode.getCommentsBefore(node);
  const previous = comments.at(-1);
  const sameLine = comments.find((comment) => comment.loc.end.line === node.loc.start.line);
  return hasAllowReason(previous) || hasAllowReason(sameLine);
}

function hasAllowReason(comment) {
  if (!comment) return false;
  const marker = "lint-allow-double-cast:";
  const index = comment.value.indexOf(marker);
  return index >= 0 && comment.value.slice(index + marker.length).trim().length > 0;
}
