import { getCallName, isIdentifier, typeReferenceName } from "../utils.js";

const message =
  "This object type duplicates a nearby Effect Schema. Export an inferred type from the schema instead. Skill: wrdn-effect-schema-inferred-types.";

const schemaSuffixPattern = /(Schema|Model|Struct)$/;

const schemaBaseName = (name) => {
  const base = name.replace(schemaSuffixPattern, "");
  return base.length > 0 && base !== name ? base : undefined;
};

const isSchemaMemberCall = (node) =>
  node?.type === "CallExpression" &&
  node.callee?.type === "MemberExpression" &&
  isIdentifier(node.callee.object, "Schema");

const isSchemaModelExpression = (node) => {
  if (isSchemaMemberCall(node)) return true;
  if (node?.type === "CallExpression" && getCallName(node.callee) === "pipe") {
    return isSchemaModelExpression(node.callee.object);
  }
  return false;
};

const isObjectTypeAlias = (node) => node.typeAnnotation?.type === "TSTypeLiteral";

const isInferredSchemaType = (node) => {
  if (node.typeAnnotation?.type !== "TSTypeReference") return false;
  const name = typeReferenceName(node.typeAnnotation);
  return name === "Schema.Schema.Type";
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    const schemaBases = new Set();
    const candidates = [];

    return {
      VariableDeclarator(node) {
        if (!isIdentifier(node.id) || !isSchemaModelExpression(node.init)) return;
        const base = schemaBaseName(node.id.name);
        if (base) schemaBases.add(base);
      },
      TSInterfaceDeclaration(node) {
        candidates.push({ node, name: node.id?.name });
      },
      TSTypeAliasDeclaration(node) {
        if (!isObjectTypeAlias(node) || isInferredSchemaType(node)) return;
        candidates.push({ node, name: node.id?.name });
      },
      "Program:exit"() {
        for (const candidate of candidates) {
          if (!candidate.name || !schemaBases.has(candidate.name)) continue;
          context.report({ node: candidate.node, message });
        }
      },
    };
  },
};
