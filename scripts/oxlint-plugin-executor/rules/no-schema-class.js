import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.js";

const message =
  "Don't use `Schema.Class` or `Schema.TaggedClass`. Use `Schema.Struct` / `Schema.TaggedStruct` and `Schema.is(schema)` for runtime checks. Effect 4 `Schema.Class` does an `instanceof` check on encode that plain objects fail, which combined with TypeScript's structural typing makes Class/Struct interchangeable at compile time but not at runtime — the gap is a recurring footgun. `Schema.TaggedErrorClass` and `Schema.ErrorClass` are exempt (typed errors).";

const isSchemaClassOrTaggedClassCall = (node) => {
  const expression = unwrapExpression(node);
  if (expression?.type !== "CallExpression") return false;

  // Walk through call expressions to find the underlying member access.
  // e.g. Schema.Class<X>("X")(fields) — the call we care about is the
  // innermost `Schema.Class<X>("X")` or just `Schema.Class`.
  let callee = unwrapExpression(expression.callee);
  while (callee?.type === "CallExpression") {
    callee = unwrapExpression(callee.callee);
  }

  if (callee?.type !== "MemberExpression") return false;
  if (!isIdentifier(unwrapExpression(callee.object), "Schema")) return false;
  const method = getPropertyName(callee.property);
  // TaggedErrorClass and ErrorClass are intentionally allowed for typed
  // errors — they're how Effect models typed-error channels.
  return method === "Class" || method === "TaggedClass";
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Schema.Class / Schema.TaggedClass anywhere in the codebase.",
    },
  },
  create(context) {
    return {
      ClassDeclaration(node) {
        if (!node.superClass) return;
        if (isSchemaClassOrTaggedClassCall(node.superClass)) {
          context.report({ node: node.superClass, message });
        }
      },
      CallExpression(node) {
        // Direct calls like `Schema.Class<X>("X")(fields)` not inside an
        // extends clause — rare but possible, e.g. inline schema creation.
        if (isSchemaClassOrTaggedClassCall(node)) {
          context.report({ node, message });
        }
      },
    };
  },
};
