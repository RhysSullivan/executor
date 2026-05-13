import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const promiseRejectMessage =
  "Do not use Promise.reject(). Model async failures with Effect.fail or Effect.tryPromise. Skill: wrdn-effect-typed-errors.";
const rejectCallbackMessage =
  "Do not call Promise executor reject(). Model async failures with Effect.fail or Effect.tryPromise. Skill: wrdn-effect-typed-errors.";

const isPromiseReject = (node) => {
  const expression = unwrapExpression(node);
  return (
    expression?.type === "MemberExpression" &&
    isIdentifier(unwrapExpression(expression.object), "Promise") &&
    getPropertyName(expression.property) === "reject"
  );
};

const isPromiseConstructor = (node) =>
  node?.type === "NewExpression" && isIdentifier(unwrapExpression(node.callee), "Promise");

const isFunction = (node) =>
  node?.type === "ArrowFunctionExpression" ||
  node?.type === "FunctionExpression" ||
  node?.type === "FunctionDeclaration";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Promise rejection APIs.",
    },
  },
  create(context) {
    const promiseExecutors = new WeakSet();
    const rejectNames = [];

    const enterFunction = (node) => {
      if (!promiseExecutors.has(node)) return;
      const rejectParam = node.params?.[1];
      if (isIdentifier(rejectParam)) {
        rejectNames.push(rejectParam.name);
      } else {
        rejectNames.push(undefined);
      }
    };

    const exitFunction = (node) => {
      if (promiseExecutors.has(node)) rejectNames.pop();
    };

    return {
      NewExpression(node) {
        if (!isPromiseConstructor(node)) return;
        const executor = node.arguments?.[0];
        if (isFunction(executor)) promiseExecutors.add(executor);
      },
      CallExpression(node) {
        if (isPromiseReject(node.callee)) {
          context.report({ node, message: promiseRejectMessage });
          return;
        }

        if (isIdentifier(node.callee) && rejectNames.includes(node.callee.name)) {
          context.report({ node, message: rejectCallbackMessage });
        }
      },
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
    };
  },
};
