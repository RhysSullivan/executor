import { isIdentifier } from "../utils.js";

const message =
  "Do not add redundant make*Error wrappers that only construct a tagged error. Construct the tagged error directly.";

const isErrorFactoryName = (name) => /^make[A-Z].*Error$/.test(name);

const isNewErrorExpression = (node) =>
  node?.type === "NewExpression" && isIdentifier(node.callee) && node.callee.name.endsWith("Error");

const returnsOnlyNewError = (node) => {
  if (isNewErrorExpression(node)) return true;
  if (node?.type !== "BlockStatement") return false;
  const statements = node.body ?? [];
  return (
    statements.length === 1 &&
    statements[0]?.type === "ReturnStatement" &&
    isNewErrorExpression(statements[0].argument)
  );
};

const reportIfRedundantFactory = (context, name, body, node) => {
  if (isErrorFactoryName(name) && returnsOnlyNewError(body)) {
    context.report({ node, message });
  }
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    return {
      FunctionDeclaration(node) {
        reportIfRedundantFactory(context, node.id?.name, node.body, node);
      },
      VariableDeclarator(node) {
        if (!isIdentifier(node.id)) return;
        if (
          node.init?.type !== "ArrowFunctionExpression" &&
          node.init?.type !== "FunctionExpression"
        ) {
          return;
        }
        reportIfRedundantFactory(context, node.id.name, node.init.body, node);
      },
    };
  },
};
