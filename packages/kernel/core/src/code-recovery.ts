import { parse } from "@babel/parser";

const FENCED_CODE_BLOCK = /```(?:[^\n`]*)?\s*\n([\s\S]*?)```/i;
const FUNCTION_DECLARATION = /^(?:async\s+)?function(?:\s+([a-zA-Z_$][a-zA-Z0-9_$]*))?\s*\(/;
const CALLABLE_ERROR = "Code must evaluate to a function";

const extractCandidateSource = (code: string): string => {
  const trimmed = code.trim();
  if (!trimmed) return "";

  const fenced = trimmed.match(FENCED_CODE_BLOCK)?.[1];
  return (fenced ?? trimmed).trim();
};

const wrapCallableBody = (source: string): string =>
  [
    "const __fn = (",
    source,
    ");",
    `if (typeof __fn !== "function") throw new Error(${JSON.stringify(CALLABLE_ERROR)});`,
    "return await __fn();",
  ].join("\n");

const wrapNamedFunctionBody = (source: string, name: string): string =>
  [source, `return await ${name}();`].join("\n");

const wrapAnonymousFunctionBody = (source: string): string => `return await (${source})();`;

const sliceNode = (
  source: string,
  node: {
    start?: number | null;
    end?: number | null;
  },
): string => {
  const start = node.start ?? 0;
  const end = node.end ?? source.length;
  return source.slice(start, end);
};

const unwrapExpression = (expression: { type: string; expression?: unknown }): unknown => {
  switch (expression.type) {
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
    case "TSInstantiationExpression":
      return expression.expression
        ? unwrapExpression(expression.expression as { type: string })
        : expression;
    default:
      return expression;
  }
};

const renderExportDefaultBody = (
  source: string,
  declaration: ExportDefaultDeclarationNode,
): string => {
  if (declaration.type === "FunctionDeclaration") {
    const fnSource = sliceNode(source, declaration);
    const name = declaration.id?.name;
    return name ? wrapNamedFunctionBody(fnSource, name) : wrapAnonymousFunctionBody(fnSource);
  }

  const expression = unwrapExpression(declaration) as {
    type?: string;
  };
  const expressionSource = sliceNode(source, declaration);

  if (expression?.type === "ArrowFunctionExpression" || expression?.type === "FunctionExpression") {
    return wrapCallableBody(expressionSource);
  }

  return `return (${expressionSource});`;
};

type ExportDefaultDeclarationNode = {
  type: string;
  start?: number | null;
  end?: number | null;
  id?: { name?: string | null } | null;
  expression?: unknown;
};

const renderParsedBody = (source: string): string => {
  const program = parse(source, {
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    plugins: ["typescript"],
  }).program;

  if (program.body.length !== 1) return source;

  const [statement] = program.body;
  if (!statement) return source;

  switch (statement.type) {
    case "ExpressionStatement": {
      const expression = unwrapExpression(
        statement.expression as { type: string; expression?: unknown },
      ) as {
        type?: string;
      };
      return expression?.type === "ArrowFunctionExpression" ||
        expression?.type === "FunctionExpression"
        ? wrapCallableBody(source)
        : source;
    }
    case "FunctionDeclaration":
      return statement.id?.name ? wrapNamedFunctionBody(source, statement.id.name) : source;
    case "ExportDefaultDeclaration":
      return renderExportDefaultBody(source, statement.declaration);
    default:
      return source;
  }
};

const renderHeuristicBody = (source: string): string => {
  const withoutDefaultExport = source.replace(/^export\s+default\s+/, "").trim();

  if (
    (withoutDefaultExport.startsWith("async") || withoutDefaultExport.startsWith("(")) &&
    withoutDefaultExport.includes("=>")
  ) {
    return wrapCallableBody(withoutDefaultExport);
  }

  if (FUNCTION_DECLARATION.test(withoutDefaultExport)) {
    const name = withoutDefaultExport.match(FUNCTION_DECLARATION)?.[1];
    return name
      ? wrapNamedFunctionBody(withoutDefaultExport, name)
      : wrapAnonymousFunctionBody(withoutDefaultExport);
  }

  return withoutDefaultExport;
};

export const recoverExecutionBody = (code: string): string => {
  const source = extractCandidateSource(code);
  if (!source) return "";

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: Babel parser throws for malformed candidate code, then recovery falls back to heuristics
  try {
    return renderParsedBody(source);
  } catch {
    return renderHeuristicBody(source);
  }
};
