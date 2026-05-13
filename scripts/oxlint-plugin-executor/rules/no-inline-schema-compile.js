import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

// Schema methods that compile a parser/guard from a schema. Calling these
// allocates a new function per invocation; the result should be hoisted to
// module (or at least closure) scope.
const COMPILER_METHODS = new Set([
  "is",
  "asserts",
  "decode",
  "decodeSync",
  "decodePromise",
  "decodeOption",
  "decodeEither",
  "decodeUnknown",
  "decodeUnknownSync",
  "decodeUnknownPromise",
  "decodeUnknownOption",
  "decodeUnknownEither",
  "encode",
  "encodeSync",
  "encodePromise",
  "encodeOption",
  "encodeEither",
  "encodeUnknown",
  "encodeUnknownSync",
  "encodeUnknownPromise",
  "encodeUnknownOption",
  "encodeUnknownEither",
  "validate",
  "validateSync",
  "validatePromise",
  "validateOption",
  "validateEither",
  "parse",
  "parseSync",
  "parsePromise",
  "parseOption",
  "parseEither",
]);

const getSchemaCompilerMethod = (callee) => {
  const expression = unwrapExpression(callee);
  if (expression?.type !== "MemberExpression") return undefined;
  const object = unwrapExpression(expression.object);
  if (!isIdentifier(object, "Schema")) return undefined;
  const method = getPropertyName(expression.property);
  return method && COMPILER_METHODS.has(method) ? method : undefined;
};

const isNestedSchemaCall = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "CallExpression") return false;
  const callee = unwrapExpression(expression.callee);
  if (callee?.type !== "MemberExpression") return false;
  const object = unwrapExpression(callee.object);
  return isIdentifier(object, "Schema");
};

const messageHigh = (method) =>
  `Hoist Schema.${method}(...) to module scope: both the inline schema literal and the compiled function are rebuilt on every call. Move the compiled function to a module-level const.`;

const messageMedium = (method) =>
  `Hoist Schema.${method}(...) to module scope: the compiled function is rebuilt on every call. Move it to a module-level const.`;

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Schema compiler calls (Schema.is/decode*/encode*/validate*/parse*) inside function bodies; hoist them to module scope.",
    },
  },
  create(context) {
    let functionDepth = 0;

    const enterFunction = () => {
      functionDepth++;
    };
    const exitFunction = () => {
      functionDepth--;
    };

    return {
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,

      CallExpression(node) {
        if (functionDepth === 0) return;
        const method = getSchemaCompilerMethod(node.callee);
        if (!method) return;
        const firstArg = node.arguments[0];
        const high = firstArg && isNestedSchemaCall(firstArg);
        context.report({
          node: node.callee,
          message: high ? messageHigh(method) : messageMedium(method),
        });
      },
    };
  },
};
