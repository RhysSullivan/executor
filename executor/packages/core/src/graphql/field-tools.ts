import type { GraphqlExecutionEnvelope } from "../tool/source-execution";
import { z } from "zod";

const recordSchema = z.record(z.unknown());

function coerceRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export interface GqlTypeRef {
  kind: string;
  name: string | null;
  ofType?: GqlTypeRef | null;
}

interface GqlField {
  name: string;
  description: string | null;
  isDeprecated?: boolean | null;
  deprecationReason?: string | null;
  args: Array<{
    name: string;
    description: string | null;
    isDeprecated?: boolean | null;
    deprecationReason?: string | null;
    type: GqlTypeRef;
    defaultValue: string | null;
  }>;
  type: GqlTypeRef;
}

interface GqlInputField {
  name: string;
  description: string | null;
  isDeprecated?: boolean | null;
  deprecationReason?: string | null;
  type: GqlTypeRef;
  defaultValue: string | null;
}

interface GqlEnumValue {
  name: string;
  description: string | null;
  isDeprecated?: boolean | null;
  deprecationReason?: string | null;
}

export interface GqlType {
  kind: string;
  name: string;
  fields: GqlField[] | null;
  inputFields: GqlInputField[] | null;
  enumValues: GqlEnumValue[] | null;
  possibleTypes?: GqlTypeRef[] | null;
}

export interface GqlSchema {
  queryType: { name: string } | null;
  mutationType: { name: string } | null;
  types: GqlType[];
}

export function selectGraphqlFieldEnvelope(
  envelope: GraphqlExecutionEnvelope,
  operationName: string,
): GraphqlExecutionEnvelope {
  const record = coerceRecord(envelope.data);
  if (Object.prototype.hasOwnProperty.call(record, operationName)) {
    return {
      data: record[operationName],
      errors: envelope.errors,
    };
  }

  return envelope;
}

export function normalizeGraphqlFieldVariables(
  argNames: string[],
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const variablePayload: Record<string, unknown> = { ...payload };
  delete variablePayload.query;
  delete variablePayload.variables;

  if (Object.keys(variablePayload).length === 0) {
    return undefined;
  }

  if (argNames.length === 1) {
    const argName = argNames[0]!;
    if (Object.prototype.hasOwnProperty.call(variablePayload, argName)) {
      const value = variablePayload[argName];
      if (
        Object.keys(variablePayload).length === 1
        && value
        && typeof value === "object"
        && !Array.isArray(value)
      ) {
          const nested = coerceRecord(value);
        if (Object.keys(nested).length === 1 && Object.prototype.hasOwnProperty.call(nested, argName)) {
          return { [argName]: nested[argName] };
        }
      }
      return variablePayload;
    }

    return { [argName]: variablePayload };
  }

  return variablePayload;
}

function unwrapType(ref: GqlTypeRef): string | null {
  if (ref.kind === "NON_NULL" && ref.ofType) return unwrapType(ref.ofType);
  if (ref.kind === "LIST" && ref.ofType) return unwrapType(ref.ofType);
  return ref.name;
}

export function gqlTypeToHint(ref: GqlTypeRef, typeMap?: Map<string, GqlType>, depth = 0): string {
  if (ref.kind === "NON_NULL" && ref.ofType) return gqlTypeToHint(ref.ofType, typeMap, depth);
  if (ref.kind === "LIST" && ref.ofType) return `${gqlTypeToHint(ref.ofType, typeMap, depth)}[]`;

  if (ref.name && typeMap && depth < 3) {
    const resolved = typeMap.get(ref.name);
    if (resolved?.kind === "INPUT_OBJECT" && resolved.inputFields) {
      return expandInputObject(resolved, typeMap, depth);
    }
    if (resolved?.kind === "ENUM" && resolved.enumValues && resolved.enumValues.length > 0) {
      const values = resolved.enumValues.slice(0, 8).map((v) => `"${v.name}"`);
      const suffix = resolved.enumValues.length > 8 ? " | ..." : "";
      return values.join(" | ") + suffix;
    }
  }

  if (ref.name) {
    switch (ref.name) {
      case "String":
      case "ID":
      case "DateTime":
      case "Date":
      case "UUID":
      case "JSONString":
      case "TimelessDate":
        return "string";
      case "Int":
      case "Float":
        return "number";
      case "Boolean":
        return "boolean";
      case "JSON":
      case "JSONObject":
        return "Record<string, unknown>";
      default:
        return ref.name;
    }
  }
  return "unknown";
}

function expandInputObject(type: GqlType, typeMap: Map<string, GqlType>, depth: number): string {
  const fields = type.inputFields;
  if (!fields || fields.length === 0) return "Record<string, unknown>";
  const entries = fields.slice(0, 16).map((f) => {
    const required = f.type.kind === "NON_NULL";
    return `${f.name}${required ? "" : "?"}: ${gqlTypeToHint(f.type, typeMap, depth + 1)}`;
  });
  const suffix = fields.length > 16 ? "; ..." : "";
  return `{ ${entries.join("; ")}${suffix} }`;
}

export function gqlFieldArgsTypeHint(args: GqlField["args"], typeMap?: Map<string, GqlType>): string {
  if (args.length === 0) return "{}";
  const entries = args.slice(0, 12).map((a) => {
    const required = a.type.kind === "NON_NULL";
    return `${a.name}${required ? "" : "?"}: ${gqlTypeToHint(a.type, typeMap)}`;
  });
  return `{ ${entries.join("; ")} }`;
}

function isGraphqlLeafType(ref: GqlTypeRef, typeMap: Map<string, GqlType>): boolean {
  const name = unwrapType(ref);
  if (!name) return true;
  const resolved = typeMap.get(name);
  if (!resolved) return true;
  return resolved.kind === "SCALAR" || resolved.kind === "ENUM";
}

function buildFieldSelectionSet(
  typeRef: GqlTypeRef,
  typeMap: Map<string, GqlType>,
  depth = 0,
  seenTypes = new Set<string>(),
): string {
  const namedType = unwrapType(typeRef);
  if (!namedType) return "";

  const resolved = typeMap.get(namedType);
  if (!resolved) return "";

  if (resolved.kind === "SCALAR" || resolved.kind === "ENUM") {
    return "";
  }

  if (resolved.kind === "UNION") {
    return "{ __typename }";
  }

  if (depth >= 2 || seenTypes.has(namedType)) {
    return "{ __typename }";
  }

  const nextSeen = new Set(seenTypes);
  nextSeen.add(namedType);

  if ((resolved.kind === "OBJECT" || resolved.kind === "INTERFACE") && resolved.fields) {
    const preferredLeafNames = ["id", "identifier", "key", "name", "title", "number", "url", "success"];
    const preferredNestedNames = ["nodes", "edges", "node", "items", "issue", "issues", "team", "teams", "viewer", "user"];

    const fields = resolved.fields.filter((field) => !field.name.startsWith("__"));
    const leafFields = resolved.fields
      .filter((field) => !field.name.startsWith("__"))
      .filter((field) => isGraphqlLeafType(field.type, typeMap));
    const nestedFields = fields.filter((field) => !isGraphqlLeafType(field.type, typeMap));

    const selectedParts: string[] = [];
    const selectedNames = new Set<string>();

    for (const preferred of preferredLeafNames) {
      const match = leafFields.find((field) => field.name === preferred);
      if (!match || selectedNames.has(match.name)) continue;
      selectedNames.add(match.name);
      selectedParts.push(match.name);
      if (selectedParts.length >= 2) break;
    }

    if (selectedParts.length < 2) {
      for (const field of leafFields) {
        if (selectedNames.has(field.name)) continue;
        selectedNames.add(field.name);
        selectedParts.push(field.name);
        if (selectedParts.length >= 2) break;
      }
    }

    const nestedCandidates = [
      ...preferredNestedNames
        .map((name) => nestedFields.find((field) => field.name === name))
        .filter((field): field is GqlField => Boolean(field)),
      ...nestedFields,
    ];

    if (selectedParts.length < 3) {
      for (const field of nestedCandidates) {
        if (selectedNames.has(field.name)) continue;
        const nestedSelection = buildFieldSelectionSet(field.type, typeMap, depth + 1, nextSeen);
        if (!nestedSelection) continue;
        selectedNames.add(field.name);
        selectedParts.push(`${field.name} ${nestedSelection}`);
        break;
      }
    }

    if (selectedParts.length === 0) {
      return "{ __typename }";
    }

    if (!selectedParts.includes("__typename")) {
      selectedParts.push("__typename");
    }

    return `{ ${selectedParts.join(" ")} }`;
  }

  return "{ __typename }";
}

export function buildFieldQuery(
  operationType: "query" | "mutation",
  fieldName: string,
  args: GqlField["args"],
  fieldType?: GqlTypeRef,
  typeMap?: Map<string, GqlType>,
): string {
  const selectionSet = fieldType && typeMap
    ? buildFieldSelectionSet(fieldType, typeMap)
    : "";
  const selectionSuffix = selectionSet ? ` ${selectionSet}` : "";

  if (args.length === 0) {
    return `${operationType} { ${fieldName}${selectionSuffix} }`;
  }
  const varDefs = args.map((a) => `$${a.name}: ${printGqlType(a.type)}`).join(", ");
  const fieldArgs = args.map((a) => `${a.name}: $${a.name}`).join(", ");
  return `${operationType}(${varDefs}) { ${fieldName}(${fieldArgs})${selectionSuffix} }`;
}

function printGqlType(ref: GqlTypeRef): string {
  if (ref.kind === "NON_NULL" && ref.ofType) return `${printGqlType(ref.ofType)}!`;
  if (ref.kind === "LIST" && ref.ofType) return `[${printGqlType(ref.ofType)}]`;
  return ref.name ?? "String";
}
