import { isIdentifier } from "../utils.js";

const message =
  "Do not duplicate plugin extension object shapes. Derive the extension type from the extension factory return value. Skill: wrdn-effect-value-inferred-types.";

const extensionNamePattern = /(?:Plugin)?Extension$/;

const isExtensionTypeName = (name) => typeof name === "string" && extensionNamePattern.test(name);

const isExtensionProperty = (node) =>
  node?.type === "Property" &&
  !node.computed &&
  ((node.key?.type === "Identifier" && node.key.name === "extension") ||
    ((node.key?.type === "Literal" || node.key?.type === "StringLiteral") &&
      node.key.value === "extension"));

const isSatisfiesExtension = (node, extensionTypeNames) =>
  node?.type === "TSSatisfiesExpression" &&
  node.typeAnnotation?.type === "TSTypeReference" &&
  isIdentifier(node.typeAnnotation.typeName) &&
  extensionTypeNames.has(node.typeAnnotation.typeName.name);

const returnsSatisfiesExtension = (node, extensionTypeNames) => {
  if (!node) return false;
  if (isSatisfiesExtension(node, extensionTypeNames)) return true;
  if (node.type === "BlockStatement") {
    return (node.body ?? []).some(
      (statement) =>
        statement.type === "ReturnStatement" &&
        isSatisfiesExtension(statement.argument, extensionTypeNames),
    );
  }
  return false;
};

const isAnnotatedExtensionFunction = (node, extensionTypeNames) =>
  (node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression") &&
  node.returnType?.typeAnnotation?.type === "TSTypeReference" &&
  isIdentifier(node.returnType.typeAnnotation.typeName) &&
  extensionTypeNames.has(node.returnType.typeAnnotation.typeName.name);

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    const extensionTypeNames = new Set();
    const extensionProperties = [];

    return {
      TSInterfaceDeclaration(node) {
        if (isExtensionTypeName(node.id?.name)) {
          extensionTypeNames.add(node.id.name);
        }
      },
      TSTypeAliasDeclaration(node) {
        if (isExtensionTypeName(node.id?.name) && node.typeAnnotation?.type === "TSTypeLiteral") {
          extensionTypeNames.add(node.id.name);
        }
      },
      Property(node) {
        if (!isExtensionProperty(node)) return;
        extensionProperties.push(node);
      },
      "Program:exit"() {
        for (const node of extensionProperties) {
          const value = node.value;
          if (
            isAnnotatedExtensionFunction(value, extensionTypeNames) ||
            returnsSatisfiesExtension(value?.body, extensionTypeNames)
          ) {
            context.report({ node, message });
          }
        }
      },
    };
  },
};
