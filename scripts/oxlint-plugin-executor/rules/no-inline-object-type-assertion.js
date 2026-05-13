import { isIdentifier } from "../utils.js";

const message =
  "Do not assert against inline object-shaped types. Use a named type, Schema, or a proper type guard. Skill: wrdn-effect-schema-boundaries.";

const isUnknownKeyword = (node) => node?.type === "TSUnknownKeyword";

const isStringKey = (node) =>
  node?.type === "TSStringKeyword" ||
  (node?.type === "TSLiteralType" && typeof node.literal?.value === "string");

const isRecordUnknown = (node) =>
  node?.type === "TSTypeReference" &&
  isIdentifier(node.typeName, "Record") &&
  node.typeArguments?.params?.length === 2 &&
  isStringKey(node.typeArguments.params[0]) &&
  isUnknownKeyword(node.typeArguments.params[1]);

const isBannedType = (node) => node?.type === "TSTypeLiteral" || isRecordUnknown(node);

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    const check = (node) => {
      if (isBannedType(node.typeAnnotation)) {
        context.report({ node, message });
      }
    };

    return {
      TSAsExpression: check,
      TSTypeAssertion: check,
    };
  },
};
