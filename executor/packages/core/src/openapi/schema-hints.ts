import { toPlainObject } from "../utils";

function toRecordOrEmpty(value: unknown): Record<string, unknown> {
  return toPlainObject(value) ?? {};
}

type JsonSchema = Record<string, unknown>;
const COMPONENT_REF_INLINE_DEPTH = 2;

function isSmallInlineableComponentSchema(schema: Record<string, unknown>): boolean {
  const shape = schema;
  const type = typeof shape.type === "string" ? shape.type : undefined;
  const props = toRecordOrEmpty(shape.properties);
  const propCount = Object.keys(props).length;
  if (type !== "object" && propCount === 0) return false;
  if (propCount === 0) return false;
  if (propCount > 8) return false;
  if (Array.isArray(shape.oneOf) || Array.isArray(shape.anyOf) || Array.isArray(shape.allOf)) return false;
  return true;
}

export type OpenApiParameterHint = {
  name: string;
  required: boolean;
  schema: Record<string, unknown>;
};

export function extractOperationIdsFromDts(dts: string): Set<string> {
  const ids = new Set<string>();
  const pattern = /^\s{2,4}(?:"([^"]+)"|([A-Za-z_]\w*))\s*:\s*\{/gm;
  const opsStart = dts.indexOf("export interface operations {");
  if (opsStart === -1) return ids;
  const opsSection = dts.slice(opsStart, opsStart + dts.length);
  for (const match of opsSection.matchAll(pattern)) {
    const id = match[1] ?? match[2];
    if (id) ids.add(id);
  }
  return ids;
}

export function getPreferredContentSchema(content: Record<string, unknown>): Record<string, unknown> {
  const preferredKeys = ["application/json", "*/*"];

  for (const key of preferredKeys) {
    const schema = toRecordOrEmpty(toRecordOrEmpty(content[key]).schema);
    if (Object.keys(schema).length > 0) return schema;
  }

  for (const [key, value] of Object.entries(content)) {
    if (!key.includes("json")) continue;
    const schema = toRecordOrEmpty(toRecordOrEmpty(value).schema);
    if (Object.keys(schema).length > 0) return schema;
  }

  for (const value of Object.values(content)) {
    const schema = toRecordOrEmpty(toRecordOrEmpty(value).schema);
    if (Object.keys(schema).length > 0) return schema;
  }

  return {};
}

export function getPreferredResponseSchema(responseValue: Record<string, unknown>): Record<string, unknown> {
  const contentSchema = getPreferredContentSchema(toRecordOrEmpty(responseValue.content));
  if (Object.keys(contentSchema).length > 0) {
    return contentSchema;
  }

  const schema = toRecordOrEmpty(responseValue.schema);
  if (Object.keys(schema).length > 0) {
    return schema;
  }

  return {};
}

export function resolveSchemaRef(
  schema: Record<string, unknown>,
  componentSchemas: Record<string, unknown>,
): Record<string, unknown> {
  const ref = typeof schema.$ref === "string" ? schema.$ref : "";
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) {
    return schema;
  }

  const key = ref.slice(prefix.length);
  const resolved = toRecordOrEmpty(componentSchemas[key]);
  if (Object.keys(resolved).length === 0) {
    return schema;
  }
  return resolved;
}

export function resolveRequestBodyRef(
  requestBody: Record<string, unknown>,
  componentRequestBodies: Record<string, unknown>,
): Record<string, unknown> {
  const ref = typeof requestBody.$ref === "string" ? requestBody.$ref : "";
  const prefix = "#/components/requestBodies/";
  if (!ref.startsWith(prefix)) {
    return requestBody;
  }

  const key = ref.slice(prefix.length);
  const resolved = toRecordOrEmpty(componentRequestBodies[key]);
  if (Object.keys(resolved).length === 0) {
    return requestBody;
  }
  return resolved;
}

export function resolveResponseRef(
  response: Record<string, unknown>,
  componentResponses: Record<string, unknown>,
): Record<string, unknown> {
  const ref = typeof response.$ref === "string" ? response.$ref : "";
  const prefix = "#/components/responses/";
  if (!ref.startsWith(prefix)) {
    return response;
  }

  const key = ref.slice(prefix.length);
  const resolved = toRecordOrEmpty(componentResponses[key]);
  if (Object.keys(resolved).length === 0) {
    return response;
  }
  return resolved;
}

export function parameterSchemaFromEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const schema = toRecordOrEmpty(entry.schema);
  if (Object.keys(schema).length > 0) {
    return schema;
  }

  const type = typeof entry.type === "string" ? entry.type : "";
  if (!type) {
    return {};
  }

  const fallback: Record<string, unknown> = { type };
  if (Array.isArray(entry.enum) && entry.enum.length > 0) {
    fallback.enum = entry.enum;
  }
  const items = toRecordOrEmpty(entry.items);
  if (Object.keys(items).length > 0) {
    fallback.items = items;
  }

  return fallback;
}

export function responseTypeHintFromSchema(
  responseSchema: Record<string, unknown>,
  responseStatus: string,
  componentSchemas?: Record<string, unknown>,
): string {
  if (Object.keys(responseSchema).length > 0) {
    return jsonSchemaTypeHintFallback(responseSchema, 0, componentSchemas);
  }

  if (responseStatus === "204" || responseStatus === "205") {
    return "void";
  }

  return "unknown";
}

function formatTsPropertyKey(key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

function formatComponentSchemaRefType(key: string): string {
  return `components["schemas"][${JSON.stringify(key)}]`;
}

function splitTopLevelBy(value: string, separator: string): string[] {
  const parts: string[] = [];
  let segment = "";
  let depthCurly = 0;
  let depthSquare = 0;
  let depthParen = 0;
  let depthAngle = 0;

  for (const char of value) {
    if (char === "{") depthCurly += 1;
    else if (char === "}") depthCurly = Math.max(0, depthCurly - 1);
    else if (char === "[") depthSquare += 1;
    else if (char === "]") depthSquare = Math.max(0, depthSquare - 1);
    else if (char === "(") depthParen += 1;
    else if (char === ")") depthParen = Math.max(0, depthParen - 1);
    else if (char === "<") depthAngle += 1;
    else if (char === ">") depthAngle = Math.max(0, depthAngle - 1);

    if (
      char === separator
      && depthCurly === 0
      && depthSquare === 0
      && depthParen === 0
      && depthAngle === 0
    ) {
      const trimmed = segment.trim();
      if (trimmed.length > 0) parts.push(trimmed);
      segment = "";
      continue;
    }

    segment += char;
  }

  const trimmed = segment.trim();
  if (trimmed.length > 0) parts.push(trimmed);
  return parts;
}

function dedupeTypeParts(parts: string[]): string[] {
  const unique: string[] = [];
  for (const part of parts) {
    const value = part.trim();
    if (!value || value === "never") continue;
    if (!unique.includes(value)) unique.push(value);
  }
  return unique;
}

function joinUnion(parts: string[]): string {
  const expanded = parts.flatMap((part) => splitTopLevelBy(part, "|"));
  const unique = dedupeTypeParts(expanded);
  if (unique.length === 0) return "unknown";
  const withoutUnknown = unique.filter((part) => part !== "unknown");
  const effective = withoutUnknown.length > 0 ? withoutUnknown : unique;
  if (effective.length === 1) return effective[0]!;

  return effective
    .map((part) => (part.includes(" & ") ? `(${part})` : part))
    .join(" | ");
}

function hasTopLevelUnion(typeHint: string): boolean {
  return splitTopLevelBy(typeHint, "|").length > 1;
}

function isObjectSchema(schema: JsonSchema): boolean {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type === "object") return true;
  return Object.keys(toRecordOrEmpty(schema.properties)).length > 0;
}

function isEmptyObjectSchema(schema: JsonSchema): boolean {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type !== "object") return false;
  return Object.keys(toRecordOrEmpty(schema.properties)).length === 0;
}

function isPlainScalarSchema(schema: JsonSchema): boolean {
  const type = typeof schema.type === "string" ? schema.type : undefined;
  if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
    return false;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return false;

  // If this scalar has any meaningful constraints, keep it.
  const allowedKeys = new Set([
    "type",
    "title",
    "description",
    "deprecated",
    "examples",
    "example",
    "nullable",
    "default",
  ]);
  for (const key of Object.keys(schema)) {
    if (!allowedKeys.has(key)) return false;
  }

  return true;
}

function normalizeUnionSchemaVariants(variants: JsonSchema[]): JsonSchema[] {
  if (variants.length < 2) return variants;

  // Many real-world OpenAPI specs include `oneOf: [{type:"object"}, { ...specific... }]`
  // or even `oneOf: [{type:"string"}, { ...object... }, { ...object... }]`.
  // These broad scalar/empty-object variants add noise without helping the UI/LLM.
  const hasNonEmptyObject = variants.some((v) => isObjectSchema(v) && Object.keys(toRecordOrEmpty(v.properties)).length > 0);

  let filtered = variants;
  if (hasNonEmptyObject) {
    filtered = filtered.filter((v) => !isEmptyObjectSchema(v));
  }

  const objectCount = filtered.filter(isObjectSchema).length;
  if (objectCount >= 2) {
    filtered = filtered.filter((v) => !isPlainScalarSchema(v));
  }

  return filtered.length > 0 ? filtered : variants;
}

function mergeParentObjectIntoUnionVariants(parent: JsonSchema, variants: JsonSchema[]): JsonSchema[] {
  const baseProps = toRecordOrEmpty(parent.properties);
  const baseRequired = (Array.isArray(parent.required) ? parent.required : [])
    .filter((value): value is string => typeof value === "string");
  const hasBaseObjectContext = parent.type === "object"
    || Object.keys(baseProps).length > 0
    || baseRequired.length > 0;
  if (!hasBaseObjectContext) return variants;

  return variants.map((variant) => {
    const variantType = typeof variant.type === "string" ? variant.type : "";
    const isObjectLikeVariant = isObjectSchema(variant)
      || (variantType === ""
        && (Array.isArray(variant.required)
          || variant.properties !== undefined
          || variant.additionalProperties !== undefined));
    if (!isObjectLikeVariant) return variant;

    const variantProps = toRecordOrEmpty(variant.properties);
    const mergedProps = {
      ...baseProps,
      ...variantProps,
    };
    const mergedRequired = [...new Set([
      ...baseRequired,
      ...(Array.isArray(variant.required) ? variant.required.filter((value): value is string => typeof value === "string") : []),
    ])];

    return {
      ...(parent.type === "object" ? { type: "object" } : {}),
      ...(parent.additionalProperties !== undefined && variant.additionalProperties === undefined
        ? { additionalProperties: parent.additionalProperties }
        : {}),
      ...variant,
      ...(Object.keys(mergedProps).length > 0 ? { properties: mergedProps } : {}),
      ...(mergedRequired.length > 0 ? { required: mergedRequired } : {}),
    };
  });
}

function mergeParentPrimitiveIntoUnionVariants(parent: JsonSchema, variants: JsonSchema[]): JsonSchema[] {
  const baseType = typeof parent.type === "string" ? parent.type : "";
  if (baseType !== "string" && baseType !== "number" && baseType !== "integer" && baseType !== "boolean" && baseType !== "null") {
    return variants;
  }

  return variants.map((variant) => {
    if (typeof variant.type === "string") return variant;
    if (typeof variant.$ref === "string") return variant;
    return {
      type: baseType,
      ...variant,
    };
  });
}

function extractStringLiteralFromSchema(schema: JsonSchema): string | null {
  // Support the two common encodings we see in OpenAPI:
  // - { type: "string", enum: ["A"] }
  // - { const: "A" }
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumValues && enumValues.length === 1 && typeof enumValues[0] === "string") {
    return enumValues[0];
  }
  if (typeof schema.const === "string") {
    return String(schema.const);
  }
  return null;
}

function repairMissingRequiredProperties(
  variants: JsonSchema[],
  depth: number,
  componentSchemas?: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): JsonSchema[] {
  // Some specs are internally inconsistent: a property is listed in `required`
  // but omitted from `properties` while `additionalProperties: false`.
  // In that case the schema is unsatisfiable; for *type hints* we patch it
  // by borrowing the property schema from sibling variants when it is stable.
  if (variants.length < 2) return variants;
  if (!variants.every(isObjectSchema)) return variants;

  const requiredLists = variants.map((v) => new Set(
    (Array.isArray(v.required) ? v.required : []).filter((k): k is string => typeof k === "string"),
  ));
  const propsLists = variants.map((v) => toRecordOrEmpty(v.properties));

  const keysToConsider = new Set<string>();
  for (const req of requiredLists) {
    for (const k of req) keysToConsider.add(k);
  }

  type InferredProp = { hint: string; schema: JsonSchema };
  const inferred = new Map<string, InferredProp>();

  for (const key of keysToConsider) {
    const candidates: Array<{ hint: string; schema: JsonSchema }> = [];
    for (let i = 0; i < variants.length; i++) {
      const props = propsLists[i]!;
      const schema = props[key];
      if (!schema || typeof schema !== "object") continue;
      const hint = jsonSchemaTypeHintFallback(schema, depth + 1, componentSchemas, seenRefs);
      if (!hint || hint === "unknown") continue;
      candidates.push({ hint, schema: toRecordOrEmpty(schema) });
    }

    if (candidates.length === 0) continue;
    const firstHint = candidates[0]!.hint;
    if (candidates.some((c) => c.hint !== firstHint)) continue;
    inferred.set(key, { hint: firstHint, schema: candidates[0]!.schema });
  }

  if (inferred.size === 0) return variants;

  let changed = false;
  const out: JsonSchema[] = [];

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i]!;
    const additionalProperties = variant.additionalProperties;
    // Only patch the strict case where the omission would make the schema invalid.
    if (additionalProperties !== false) {
      out.push(variant);
      continue;
    }

    const required = requiredLists[i]!;
    const props = propsLists[i]!;
    const missing: string[] = [];

    for (const key of required) {
      if (props[key] !== undefined) continue;
      if (!inferred.has(key)) continue;
      missing.push(key);
    }

    if (missing.length === 0) {
      out.push(variant);
      continue;
    }

    changed = true;
    const nextProps: Record<string, unknown> = { ...props };
    for (const key of missing) {
      nextProps[key] = inferred.get(key)!.schema;
    }

    out.push({
      ...variant,
      properties: nextProps,
    });
  }

  return changed ? out : variants;
}

function mergeDiscriminatedObjectUnionVariants(
  variants: JsonSchema[],
  discriminantKey: string,
  depth: number,
  componentSchemas?: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): JsonSchema[] {
  if (variants.length < 2) return variants;
  if (!variants.every(isObjectSchema)) return variants;

  type VariantInfo = {
    idx: number;
    schema: JsonSchema;
    disc: string;
    signature: string;
  };

  const infos: VariantInfo[] = [];

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i]!;
    const props = toRecordOrEmpty(variant.properties);
    const discSchema = toRecordOrEmpty(props[discriminantKey]);
    const disc = extractStringLiteralFromSchema(discSchema);
    if (!disc) {
      return variants;
    }

    const required = new Set(
      (Array.isArray(variant.required) ? variant.required : []).filter(
        (k): k is string => typeof k === "string",
      ),
    );

    const otherKeys = Object.keys(props)
      .filter((k) => k !== discriminantKey)
      .sort();
    const requiredOther = [...required]
      .filter((k) => k !== discriminantKey)
      .sort();

    const keyHints = otherKeys.map((k) => {
      const hint = jsonSchemaTypeHintFallback(props[k], depth + 1, componentSchemas, seenRefs);
      return `${k}:${hint}`;
    });

    // Group by: same other keys + same required set + same per-key hints.
    const signature = JSON.stringify({ otherKeys, requiredOther, keyHints });
    infos.push({ idx: i, schema: variant, disc, signature });
  }

  const bySig = new Map<string, VariantInfo[]>();
  for (const info of infos) {
    const bucket = bySig.get(info.signature);
    if (bucket) bucket.push(info);
    else bySig.set(info.signature, [info]);
  }

  let changed = false;
  const used = new Set<number>();
  const out: JsonSchema[] = [];

  // Preserve stable order: walk original variants and emit merged groups
  // when we encounter their first member.
  for (let i = 0; i < variants.length; i++) {
    if (used.has(i)) continue;
    const info = infos.find((x) => x.idx === i);
    if (!info) {
      out.push(variants[i]!);
      continue;
    }

    const group = bySig.get(info.signature) ?? [info];
    if (group.length < 2) {
      out.push(variants[i]!);
      used.add(i);
      continue;
    }

    // Merge group: same schema shape, only discriminant differs.
    changed = true;
    for (const member of group) used.add(member.idx);

    const base = group[0]!.schema;
    const baseProps = toRecordOrEmpty(base.properties);
    const discSchema = toRecordOrEmpty(baseProps[discriminantKey]);
    const discType = typeof discSchema.type === "string" ? discSchema.type : "string";

    const mergedDiscriminant: JsonSchema = {
      type: discType,
      enum: group.map((m) => m.disc),
    };

    const mergedProps = {
      ...baseProps,
      [discriminantKey]: mergedDiscriminant,
    };

    out.push({
      ...base,
      properties: mergedProps,
    });
  }

  return changed ? out : variants;
}

function subsetKeys(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  for (const key of left) {
    if (!rightSet.has(key)) return false;
  }
  return true;
}

function tryCollapseSimpleObjectUnion(
  variants: JsonSchema[],
  depth: number,
  componentSchemas?: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): string | null {
  if (variants.length !== 2) return null;
  const left = variants[0]!;
  const right = variants[1]!;
  if (!isObjectSchema(left) || !isObjectSchema(right)) return null;

  const leftProps = toRecordOrEmpty(left.properties);
  const rightProps = toRecordOrEmpty(right.properties);
  const leftKeys = Object.keys(leftProps);
  const rightKeys = Object.keys(rightProps);
  if (leftKeys.length === 0 || rightKeys.length === 0) return null;

  // Only collapse the simplest case: one object is a strict subset of the other
  // and they differ by exactly one additional property.
  const leftSubRight = subsetKeys(leftKeys, rightKeys);
  const rightSubLeft = subsetKeys(rightKeys, leftKeys);
  if (!leftSubRight && !rightSubLeft) return null;

  const sup = leftSubRight ? right : left;
  const sub = leftSubRight ? left : right;
  const supProps = toRecordOrEmpty(sup.properties);
  const subProps = toRecordOrEmpty(sub.properties);
  const supKeys = Object.keys(supProps);
  const subKeys = Object.keys(subProps);
  const extraKeys = supKeys.filter((k) => !subKeys.includes(k));
  if (extraKeys.length !== 1) return null;

  // Shared keys must have identical type hints.
  for (const key of subKeys) {
    const supHint = jsonSchemaTypeHintFallback(supProps[key], depth + 1, componentSchemas, seenRefs);
    const subHint = jsonSchemaTypeHintFallback(subProps[key], depth + 1, componentSchemas, seenRefs);
    if (supHint !== subHint) return null;
  }

  const requiredSup = new Set((Array.isArray(sup.required) ? sup.required : []).filter((v): v is string => typeof v === "string"));
  const requiredSub = new Set((Array.isArray(sub.required) ? sub.required : []).filter((v): v is string => typeof v === "string"));
  const requiredBoth = new Set<string>();
  for (const key of subKeys) {
    if (requiredSup.has(key) && requiredSub.has(key)) {
      requiredBoth.add(key);
    }
  }

  const inner = supKeys
    .map((key) => {
      const hint = jsonSchemaTypeHintFallback(supProps[key], depth + 1, componentSchemas, seenRefs);
      return `${formatTsPropertyKey(key)}${requiredBoth.has(key) ? "" : "?"}: ${hint}`;
    })
    .join("; ");

  return `{ ${inner} }`;
}

function intersectKeys(variants: Array<Record<string, unknown>>): string[] {
  if (variants.length === 0) return [];
  const sets = variants.map((props) => new Set(Object.keys(props)));
  const [first, ...rest] = sets;
  if (!first) return [];
  const out: string[] = [];
  for (const key of first) {
    if (rest.every((set) => set.has(key))) {
      out.push(key);
    }
  }
  return out;
}

function tryFactorCommonObjectFields(
  variants: JsonSchema[],
  depth: number,
  componentSchemas?: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): string | null {
  if (variants.length < 2) return null;
  if (!variants.every(isObjectSchema)) return null;

  const propsList = variants.map((v) => toRecordOrEmpty(v.properties));
  const commonKeys = intersectKeys(propsList);
  if (commonKeys.length === 0) return null;

  const commonEntries: Array<{ key: string; hint: string; required: boolean }> = [];
  for (const key of commonKeys) {
    const hints = variants.map((v) => jsonSchemaTypeHintFallback(toRecordOrEmpty(v.properties)[key], depth + 1, componentSchemas, seenRefs));
    const firstHint = hints[0];
    if (!firstHint || hints.some((h) => h !== firstHint)) continue;

    const requiredEverywhere = variants.every((v) => {
      const req = Array.isArray(v.required) ? v.required : [];
      return req.includes(key);
    });
    commonEntries.push({ key, hint: firstHint, required: requiredEverywhere });
  }

  if (commonEntries.length === 0) return null;

  const commonProps = new Set(commonEntries.map((e) => e.key));
  const residualSchemas: JsonSchema[] = [];
  for (const variant of variants) {
    const props = toRecordOrEmpty(variant.properties);
    const residualProps = Object.fromEntries(Object.entries(props).filter(([key]) => !commonProps.has(key)));
    const req = Array.isArray(variant.required) ? variant.required : [];
    const residualRequired = req.filter((key) => typeof key === "string" && !commonProps.has(key));
    residualSchemas.push({
      type: "object",
      properties: residualProps,
      ...(residualRequired.length > 0 ? { required: residualRequired } : {}),
    });
  }

  // If factoring doesn't reduce anything, bail.
  const reduces = residualSchemas.some((s) => Object.keys(toRecordOrEmpty(s.properties)).length > 0);
  if (!reduces) return null;

  const commonInner = commonEntries
    .map((e) => `${formatTsPropertyKey(e.key)}${e.required ? "" : "?"}: ${e.hint}`)
    .join("; ");
  const commonType = `{ ${commonInner} }`;

  const partiallyFactoredResidual = tryFactorPartialCommonObjectFields(
    residualSchemas,
    depth,
    componentSchemas,
    seenRefs,
  );

  const residualType = partiallyFactoredResidual
    ?? jsonSchemaTypeHintFallback({ oneOf: residualSchemas }, depth + 1, componentSchemas, seenRefs);
  if (residualType === "unknown") return commonType;

  return `${commonType} & (${residualType})`;
}

function tryFactorPartialCommonObjectFields(
  variants: JsonSchema[],
  depth: number,
  componentSchemas?: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): string | null {
  // If there's a large union where a field repeats across many (but not all)
  // object variants (e.g. Vercel DNS createRecord repeats `name` in most
  // variants), pull it out as:
  //   ({ name: string } & (<union-without-name>)) | <remaining>
  // This is purely a *hint* readability improvement.

  if (variants.length < 3) return null;
  if (!variants.every(isObjectSchema)) return null;

  const propsList = variants.map((v) => toRecordOrEmpty(v.properties));
  const requiredList = variants.map((v) => new Set(
    (Array.isArray(v.required) ? v.required : []).filter((k): k is string => typeof k === "string"),
  ));

  type Candidate = {
    key: string;
    hint: string;
    indices: number[];
  };

  const candidates: Candidate[] = [];
  const minGroupSize = variants.length >= 4 ? 3 : 2;

  // Collect keys present in at least minGroupSize variants.
  const keyCounts = new Map<string, number>();
  for (const props of propsList) {
    for (const key of Object.keys(props)) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }

  for (const [key, count] of keyCounts.entries()) {
    if (count < minGroupSize) continue;

    // Consider only keys that are required in the variants we factor.
    const indicesWithKey = propsList
      .map((props, idx) => (props[key] !== undefined ? idx : -1))
      .filter((idx) => idx !== -1);

    // Group by identical type hint.
    const byHint = new Map<string, number[]>();
    for (const idx of indicesWithKey) {
      const variant = variants[idx]!;
      if (!requiredList[idx]!.has(key)) continue;
      const props = propsList[idx]!;
      const hint = jsonSchemaTypeHintFallback(props[key], depth + 1, componentSchemas, seenRefs);
      const bucket = byHint.get(hint);
      if (bucket) bucket.push(idx);
      else byHint.set(hint, [idx]);
    }

    for (const [hint, indices] of byHint.entries()) {
      if (indices.length < minGroupSize) continue;
      if (indices.length === variants.length) continue;
      candidates.push({ key, hint, indices });
    }
  }

  if (candidates.length === 0) return null;

  // Pick the best candidate: largest group first, then stable key order.
  candidates.sort((a, b) => {
    if (b.indices.length !== a.indices.length) return b.indices.length - a.indices.length;
    if (a.key !== b.key) return a.key.localeCompare(b.key);
    return a.hint.localeCompare(b.hint);
  });
  const best = candidates[0]!;

  // Build the factored group.
  const commonType = `{ ${formatTsPropertyKey(best.key)}: ${best.hint} }`;
  const bestSet = new Set(best.indices);

  const residualSchemas: JsonSchema[] = [];
  const remainingSchemas: JsonSchema[] = [];

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i]!;
    const props = propsList[i]!;
    if (!bestSet.has(i)) {
      remainingSchemas.push(variant);
      continue;
    }

    const residualProps = Object.fromEntries(
      Object.entries(props).filter(([k]) => k !== best.key),
    );
    const req = Array.isArray(variant.required) ? variant.required : [];
    const residualRequired = req.filter(
      (k) => typeof k === "string" && k !== best.key,
    );

    residualSchemas.push({
      type: "object",
      properties: residualProps,
      ...(residualRequired.length > 0 ? { required: residualRequired } : {}),
    });
  }

  // If factoring doesn't actually remove anything useful, bail.
  const anyResidualHasProps = residualSchemas.some(
    (s) => Object.keys(toRecordOrEmpty(s.properties)).length > 0,
  );
  if (!anyResidualHasProps) return null;

  const residualType = joinUnion(residualSchemas.map((s) => jsonSchemaTypeHintFallback(s, depth + 1, componentSchemas, seenRefs)));
  const groupType = `${commonType} & (${residualType})`;

  if (remainingSchemas.length === 0) return groupType;
  const remainingType = joinUnion(remainingSchemas.map((s) => jsonSchemaTypeHintFallback(s, depth + 1, componentSchemas, seenRefs)));
  return joinUnion([groupType, remainingType]);
}

function joinIntersection(parts: string[]): string {
  const expanded = parts.flatMap((part) => splitTopLevelBy(part, "&"));
  const unique = dedupeTypeParts(expanded).filter((part) => part !== "unknown");
  if (unique.length === 0) return "unknown";
  const wrapped = unique.map((part) => (hasTopLevelUnion(part) ? `(${part})` : part));
  return wrapped.length === 1 ? wrapped[0]! : wrapped.join(" & ");
}

function maybeParenthesizeArrayElement(typeHint: string): string {
  return typeHint.includes(" | ") || typeHint.includes(" & ")
    ? `(${typeHint})`
    : typeHint;
}

export function jsonSchemaTypeHintFallback(
  schema: unknown,
  depth = 0,
  componentSchemas?: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): string {
  if (!schema || typeof schema !== "object") return "unknown";
  if (depth > 12) return "unknown";

  const shape = toRecordOrEmpty(schema);
  if (typeof shape.$ref === "string") {
    const ref = shape.$ref;
    const prefix = "#/components/schemas/";
    if (ref.startsWith(prefix)) {
      const key = ref.slice(prefix.length);
      const resolved = componentSchemas ? toRecordOrEmpty(componentSchemas[key]) : {};
      const canInline = Object.keys(resolved).length > 0
        && !seenRefs.has(ref)
        && (depth < COMPONENT_REF_INLINE_DEPTH || isSmallInlineableComponentSchema(resolved));

      if (canInline) {
        const nextSeen = new Set(seenRefs);
        nextSeen.add(ref);
        return jsonSchemaTypeHintFallback(resolved, depth + 1, componentSchemas, nextSeen);
      }

      // Fall back to a stable named reference.
      return formatComponentSchemaRefType(key);
    }
  }

  const enumValues = Array.isArray(shape.enum) ? shape.enum : undefined;
  if (enumValues && enumValues.length > 0) {
    return enumValues.map((value) => JSON.stringify(value)).join(" | ");
  }

  const oneOf = Array.isArray(shape.oneOf) ? shape.oneOf : undefined;
  if (oneOf && oneOf.length > 0) {
    const variants = normalizeUnionSchemaVariants(mergeParentObjectIntoUnionVariants(
      shape,
      mergeParentPrimitiveIntoUnionVariants(
        shape,
        oneOf.filter((entry): entry is JsonSchema => Boolean(entry && typeof entry === "object")),
      ),
    ));
    const objectVariantsPrepared = repairMissingRequiredProperties(
      variants.filter(isObjectSchema),
      depth,
      componentSchemas,
      seenRefs,
    );
    const objectVariantsMerged = mergeDiscriminatedObjectUnionVariants(
      objectVariantsPrepared,
      "type",
      depth,
      componentSchemas,
      seenRefs,
    );
    const mergedVariants = variants.some((v) => !isObjectSchema(v))
      ? variants.filter((v) => !isObjectSchema(v)).concat(objectVariantsMerged)
      : objectVariantsMerged;
    const objectVariants = mergedVariants.filter(isObjectSchema);

    const collapsed = tryCollapseSimpleObjectUnion(
      objectVariants,
      depth,
      componentSchemas,
      seenRefs,
    );
    if (collapsed) return collapsed;

    const factored = tryFactorCommonObjectFields(
      objectVariants,
      depth,
      componentSchemas,
      seenRefs,
    );
    if (factored) return factored;

    const partial = tryFactorPartialCommonObjectFields(
      objectVariants,
      depth,
      componentSchemas,
      seenRefs,
    );
    if (partial) return partial;
    return joinUnion(mergedVariants.map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1, componentSchemas, seenRefs)));
  }

  const anyOf = Array.isArray(shape.anyOf) ? shape.anyOf : undefined;
  if (anyOf && anyOf.length > 0) {
    const variants = normalizeUnionSchemaVariants(mergeParentObjectIntoUnionVariants(
      shape,
      mergeParentPrimitiveIntoUnionVariants(
        shape,
        anyOf.filter((entry): entry is JsonSchema => Boolean(entry && typeof entry === "object")),
      ),
    ));
    const objectVariantsPrepared = repairMissingRequiredProperties(
      variants.filter(isObjectSchema),
      depth,
      componentSchemas,
      seenRefs,
    );
    const objectVariantsMerged = mergeDiscriminatedObjectUnionVariants(
      objectVariantsPrepared,
      "type",
      depth,
      componentSchemas,
      seenRefs,
    );
    const mergedVariants = variants.some((v) => !isObjectSchema(v))
      ? variants.filter((v) => !isObjectSchema(v)).concat(objectVariantsMerged)
      : objectVariantsMerged;
    const objectVariants = mergedVariants.filter(isObjectSchema);

    const collapsed = tryCollapseSimpleObjectUnion(
      objectVariants,
      depth,
      componentSchemas,
      seenRefs,
    );
    if (collapsed) return collapsed;

    const factored = tryFactorCommonObjectFields(
      objectVariants,
      depth,
      componentSchemas,
      seenRefs,
    );
    if (factored) return factored;

    const partial = tryFactorPartialCommonObjectFields(
      objectVariants,
      depth,
      componentSchemas,
      seenRefs,
    );
    if (partial) return partial;
    return joinUnion(mergedVariants.map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1, componentSchemas, seenRefs)));
  }

  const allOf = Array.isArray(shape.allOf) ? shape.allOf : undefined;
  if (allOf && allOf.length > 0) {
    const parts = allOf.map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1, componentSchemas, seenRefs));
    return joinIntersection(parts);
  }

  const type = typeof shape.type === "string" ? shape.type : undefined;
  const tupleItems = Array.isArray(shape.items) ? shape.items : undefined;
  if (!type && tupleItems && tupleItems.length > 0) {
    return joinUnion(tupleItems.map((entry) => jsonSchemaTypeHintFallback(entry, depth + 1, componentSchemas, seenRefs)));
  }
  if (type === "integer") return "number";
  if (type === "string" || type === "number" || type === "boolean" || type === "null") {
    return type;
  }

  if (type === "array") {
    const itemType = jsonSchemaTypeHintFallback(shape.items, depth + 1, componentSchemas, seenRefs);
    return `${maybeParenthesizeArrayElement(itemType)}[]`;
  }

  const props = toRecordOrEmpty(shape.properties);
  const additionalProperties = shape.additionalProperties;
  const requiredRaw = Array.isArray(shape.required) ? shape.required : [];
  const required = new Set(requiredRaw.filter((item): item is string => typeof item === "string"));
  const propEntries = Object.entries(props);
  if (type === "object" || propEntries.length > 0) {
    if (propEntries.length === 0) {
      if (additionalProperties && typeof additionalProperties === "object") {
        return `Record<string, ${jsonSchemaTypeHintFallback(additionalProperties, depth + 1, componentSchemas, seenRefs)}>`;
      }
      return "Record<string, unknown>";
    }
    const maxInlineProps = 1000;
    const isTruncated = propEntries.length > maxInlineProps;
    const inner = propEntries
      .slice(0, maxInlineProps)
      .map(([key, value]) => `${formatTsPropertyKey(key)}${required.has(key) ? "" : "?"}: ${jsonSchemaTypeHintFallback(value, depth + 1, componentSchemas, seenRefs)}`)
      .join("; ");
    const indexSignature = isTruncated ? `${inner ? "; " : ""}[key: string]: any` : "";
    return `{ ${inner}${indexSignature} }`;
  }

  return "unknown";
}

function pushUnique(values: string[], seen: Set<string>, raw: string): void {
  const value = raw.trim();
  if (!value || seen.has(value)) return;
  seen.add(value);
  values.push(value);
}

function collectTopLevelSchemaKeys(
  schema: unknown,
  componentSchemas?: Record<string, unknown>,
  seenRefs: Set<string> = new Set(),
): string[] {
  if (!schema || typeof schema !== "object") return [];

  const record = toRecordOrEmpty(schema);
  const ref = typeof record.$ref === "string" ? record.$ref : "";
  if (ref.startsWith("#/components/schemas/")) {
    if (seenRefs.has(ref)) return [];
    const key = ref.slice("#/components/schemas/".length);
    const resolved = componentSchemas ? toRecordOrEmpty(componentSchemas[key]) : {};
    if (Object.keys(resolved).length === 0) return [];
    const nextSeen = new Set(seenRefs);
    nextSeen.add(ref);
    return collectTopLevelSchemaKeys(resolved, componentSchemas, nextSeen);
  }

  const keys: string[] = [];
  const seen = new Set<string>();

  for (const key of Object.keys(toRecordOrEmpty(record.properties))) {
    pushUnique(keys, seen, key);
  }

  const combinators: unknown[] = [
    ...(Array.isArray(record.allOf) ? record.allOf : []),
    ...(Array.isArray(record.oneOf) ? record.oneOf : []),
    ...(Array.isArray(record.anyOf) ? record.anyOf : []),
  ];

  for (const entry of combinators) {
    for (const key of collectTopLevelSchemaKeys(entry, componentSchemas, seenRefs)) {
      pushUnique(keys, seen, key);
    }
  }

  return keys;
}

export function buildOpenApiInputSchema(
  parameters: OpenApiParameterHint[],
  requestBodySchema: Record<string, unknown>,
): JsonSchema {
  const hasBodySchema = Object.keys(requestBodySchema).length > 0;
  const hasParams = parameters.length > 0;

  if (!hasBodySchema && !hasParams) {
    return {};
  }

  const parameterSchema: JsonSchema = {
    type: "object",
    properties: Object.fromEntries(parameters.map((param) => [param.name, param.schema])),
    required: parameters.filter((param) => param.required).map((param) => param.name),
  };

  if (!hasBodySchema) {
    return parameterSchema;
  }

  if (!hasParams) {
    return requestBodySchema;
  }

  return {
    allOf: [parameterSchema, requestBodySchema],
  };
}

export function buildOpenApiArgPreviewKeys(
  parameters: OpenApiParameterHint[],
  requestBodySchema: Record<string, unknown>,
  componentSchemas?: Record<string, unknown>,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const parameter of parameters) {
    if (!parameter.required) continue;
    pushUnique(keys, seen, parameter.name);
  }

  for (const key of collectTopLevelSchemaKeys(requestBodySchema, componentSchemas)) {
    pushUnique(keys, seen, key);
  }

  for (const parameter of parameters) {
    if (parameter.required) continue;
    pushUnique(keys, seen, parameter.name);
  }

  return keys;
}

function collectComponentRefKeysDeep(
  schema: unknown,
  componentSchemas: Record<string, unknown>,
  seenRefs: Set<string>,
  seenObjects: WeakSet<object>,
  refKeys: Set<string>,
): void {
  if (!schema || typeof schema !== "object") return;

  if (Array.isArray(schema)) {
    for (const entry of schema) {
      collectComponentRefKeysDeep(entry, componentSchemas, seenRefs, seenObjects, refKeys);
    }
    return;
  }

  const obj = schema as object;
  if (seenObjects.has(obj)) return;
  seenObjects.add(obj);

  const record = toRecordOrEmpty(schema);
  const ref = typeof record.$ref === "string" ? record.$ref : "";
  const prefix = "#/components/schemas/";
  if (ref.startsWith(prefix)) {
    if (seenRefs.has(ref)) return;
    seenRefs.add(ref);

    const key = ref.slice(prefix.length);
    if (key) refKeys.add(key);

    const resolved = toRecordOrEmpty(componentSchemas[key]);
    if (Object.keys(resolved).length > 0) {
      collectComponentRefKeysDeep(resolved, componentSchemas, seenRefs, seenObjects, refKeys);
    }
    return;
  }

  for (const value of Object.values(record)) {
    collectComponentRefKeysDeep(value, componentSchemas, seenRefs, seenObjects, refKeys);
  }
}

export function collectComponentRefKeys(
  schemas: unknown[],
  componentSchemas: Record<string, unknown>,
): string[] {
  const refKeys = new Set<string>();
  const seenRefs = new Set<string>();
  const seenObjects = new WeakSet<object>();

  for (const schema of schemas) {
    collectComponentRefKeysDeep(schema, componentSchemas, seenRefs, seenObjects, refKeys);
  }

  return [...refKeys].sort((left, right) => left.localeCompare(right));
}

export function buildComponentRefHintTable(
  refKeys: Iterable<string>,
  componentSchemas: Record<string, unknown>,
): Record<string, string> {
  const hints: Record<string, string> = {};
  const sorted = [...refKeys].sort((left, right) => left.localeCompare(right));
  for (const key of sorted) {
    const resolved = toRecordOrEmpty(componentSchemas[key]);
    if (Object.keys(resolved).length === 0) continue;
    hints[key] = jsonSchemaTypeHintFallback(resolved, 0, componentSchemas);
  }

  return hints;
}
