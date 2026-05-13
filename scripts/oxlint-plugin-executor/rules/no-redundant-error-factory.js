import { isIdentifier } from "../utils.js";

const message =
  "Do not add redundant helpers that only construct a tagged error. Construct the tagged error directly. Skill: wrdn-effect-typed-errors.";

const isErrorFactoryName = (name) => /^make[A-Z].*Error$/.test(name);

const isErrorHelperName = (name) =>
  isErrorFactoryName(name) || String(name ?? "").endsWith("Error");

const parameterName = (param) => {
  if (isIdentifier(param)) return param.name;
  if (param?.type === "AssignmentPattern" && isIdentifier(param.left)) return param.left.name;
  if (param?.type === "RestElement" && isIdentifier(param.argument)) return param.argument.name;
  return undefined;
};

const isNewErrorExpression = (node) =>
  node?.type === "NewExpression" && isIdentifier(node.callee) && node.callee.name.endsWith("Error");

const isForwardedValue = (node, parameterNames) => {
  if (node?.type === "Literal" || node?.type === "StringLiteral") return true;
  if (node?.type === "Identifier") return parameterNames.has(node.name);
  return (
    node?.type === "MemberExpression" &&
    isIdentifier(node.object) &&
    parameterNames.has(node.object.name)
  );
};

const isObjectWithOnlyForwardedFields = (node, parameterNames) => {
  if (node?.type !== "ObjectExpression") return true;
  return (node.properties ?? []).every((property) => {
    if (property.type === "SpreadElement") return false;
    return isForwardedValue(property.value, parameterNames);
  });
};

const isRedundantNewErrorExpression = (node, parameterNames) => {
  if (!isNewErrorExpression(node)) return false;
  if ((node.arguments ?? []).length === 0) return true;
  if (node.arguments.length > 1) return false;
  const argument = node.arguments[0];
  if (argument?.type === "Identifier") return parameterNames.has(argument.name);
  return isObjectWithOnlyForwardedFields(argument, parameterNames);
};

const returnsOnlyNewError = (node) => {
  const parameterNames = new Set((node?.params ?? []).map(parameterName).filter(Boolean));
  if (isRedundantNewErrorExpression(node?.body ?? node, parameterNames)) return true;
  if (node?.type !== "BlockStatement") return false;
  const statements = node.body ?? [];
  return (
    statements.length === 1 &&
    statements[0]?.type === "ReturnStatement" &&
    isRedundantNewErrorExpression(statements[0].argument, parameterNames)
  );
};

const reportIfRedundantFactory = (context, name, fnNode, reportNode) => {
  if (isErrorHelperName(name) && returnsOnlyNewError(fnNode)) {
    context.report({ node: reportNode, message });
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
        reportIfRedundantFactory(context, node.id?.name, node, node);
      },
      VariableDeclarator(node) {
        if (!isIdentifier(node.id)) return;
        if (
          node.init?.type !== "ArrowFunctionExpression" &&
          node.init?.type !== "FunctionExpression"
        ) {
          return;
        }
        reportIfRedundantFactory(context, node.id.name, node.init, node);
      },
    };
  },
};
