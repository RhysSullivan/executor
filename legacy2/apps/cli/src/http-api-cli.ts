import * as HttpApi from "@effect/platform/HttpApi";
import * as AST from "effect/SchemaAST";
import * as Option from "effect/Option";

type ParsedArgs = {
  positional: Array<string>;
  flags: Record<string, string | boolean>;
};

type EndpointField = {
  name: string;
  optional: boolean;
  ast: AST.AST;
};

export type EndpointCommand = {
  groupName: string;
  endpointName: string;
  endpointCliName: string;
  method: string;
  path: string;
  pathFields: Array<EndpointField>;
  payloadFields: Array<EndpointField>;
  urlParamFields: Array<EndpointField>;
  hasPayloadSchema: boolean;
};

type CliInvokeOptions = {
  request: Record<string, unknown>;
  command: EndpointCommand;
};

export type HttpApiCliRunnerOptions = {
  parsed: ParsedArgs;
  invoke: (input: CliInvokeOptions) => Promise<unknown>;
  print: (value: unknown) => void;
  resolveDefaultPathValue?: (name: string) => Promise<string | undefined>;
};

export type HttpApiCli = {
  readonly helpText: string;
  readonly commands: ReadonlyArray<EndpointCommand>;
  readonly execute: (options: {
    groupName: string;
    endpointName: string;
    flags: Record<string, string | boolean>;
    invoke: (input: CliInvokeOptions) => Promise<unknown>;
    print: (value: unknown) => void;
    resolveDefaultPathValue?: (name: string) => Promise<string | undefined>;
  }) => Promise<boolean>;
  readonly run: (options: HttpApiCliRunnerOptions) => Promise<boolean>;
};

const toKebab = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

const unwrapAst = (ast: AST.AST): AST.AST => {
  if (ast._tag === "Transformation") {
    return unwrapAst(ast.to);
  }
  if (ast._tag === "Suspend") {
    return unwrapAst(ast.f());
  }
  return ast;
};

const collectTypeLiteralFields = (ast: AST.AST): Array<EndpointField> => {
  const candidate = unwrapAst(ast);
  if (candidate._tag !== "TypeLiteral") {
    return [];
  }

  return candidate.propertySignatures.flatMap((signature) =>
    typeof signature.name === "string"
      ? [
          {
            name: signature.name,
            optional: signature.isOptional,
            ast: signature.type,
          },
        ]
      : [],
  );
};

const isBooleanTrue = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const coerceByAst = (raw: string, ast: AST.AST): unknown => {
  const candidate = unwrapAst(ast);
  switch (candidate._tag) {
    case "StringKeyword":
      return raw;
    case "NumberKeyword": {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Expected number, got: ${raw}`);
      }
      return numeric;
    }
    case "BooleanKeyword":
      return isBooleanTrue(raw);
    case "Literal": {
      if (`${candidate.literal}`.toLowerCase() !== raw.toLowerCase()) {
        throw new Error(`Expected literal ${String(candidate.literal)}, got ${raw}`);
      }
      return candidate.literal;
    }
    case "Union": {
      const unionCandidates = candidate.types.filter((type) => type._tag !== "UndefinedKeyword");
      for (const unionType of unionCandidates) {
        try {
          return coerceByAst(raw, unionType);
        } catch {
          continue;
        }
      }
      return raw;
    }
    default:
      return raw;
  }
};

const usageForCommand = (command: EndpointCommand): string => {
  const flags = [
    ...command.pathFields.map((field) => `--${field.name} <value>`),
    ...command.payloadFields.map((field) =>
      field.optional ? `[--${field.name} <value>]` : `--${field.name} <value>`,
    ),
    ...command.urlParamFields.map((field) =>
      field.optional ? `[--${field.name} <value>]` : `--${field.name} <value>`,
    ),
    ...(command.hasPayloadSchema ? ["[--payload-json '<json>']"] : []),
  ].join(" ");

  return `executor ${command.groupName} ${command.endpointCliName}${flags.length > 0 ? ` ${flags}` : ""}`;
};

const buildCommandList = (api: HttpApi.HttpApi.Any): Array<EndpointCommand> => {
  const commands: Array<EndpointCommand> = [];
  HttpApi.reflect(api as HttpApi.HttpApi.AnyWithProps, {
    onGroup: () => undefined,
    onEndpoint: ({ group, endpoint }) => {
      const payloadSchema = Option.getOrNull(endpoint.payloadSchema);
      const urlParamsSchema = Option.getOrNull(endpoint.urlParamsSchema);
      const pathSchema = Option.getOrNull(endpoint.pathSchema);

      commands.push({
        groupName: group.identifier,
        endpointName: endpoint.name,
        endpointCliName: toKebab(endpoint.name),
        method: endpoint.method,
        path: endpoint.path,
        pathFields: pathSchema ? collectTypeLiteralFields(pathSchema.ast) : [],
        payloadFields: payloadSchema ? collectTypeLiteralFields(payloadSchema.ast) : [],
        urlParamFields: urlParamsSchema ? collectTypeLiteralFields(urlParamsSchema.ast) : [],
        hasPayloadSchema: payloadSchema !== null,
      });
    },
  });
  return commands;
};

const buildRequestObject = async (
  command: EndpointCommand,
  options: HttpApiCliRunnerOptions,
): Promise<Record<string, unknown>> => {
  const request: Record<string, unknown> = {};

  if (command.pathFields.length > 0) {
    const path: Record<string, unknown> = {};
    for (const field of command.pathFields) {
      const flagValue = options.parsed.flags[field.name];
      const explicit = typeof flagValue === "string" ? flagValue : undefined;
      const fallback = options.resolveDefaultPathValue
        ? await options.resolveDefaultPathValue(field.name)
        : undefined;
      const chosen = explicit ?? fallback;
      if (!chosen) {
        throw new Error(
          `Missing required path parameter --${field.name}. Usage: ${usageForCommand(command)}`,
        );
      }
      path[field.name] = coerceByAst(chosen, field.ast);
    }
    request.path = path;
  }

  if (command.urlParamFields.length > 0) {
    const urlParams: Record<string, unknown> = {};
    for (const field of command.urlParamFields) {
      const value = options.parsed.flags[field.name];
      if (typeof value !== "string") {
        if (field.optional) {
          continue;
        }
        throw new Error(
          `Missing required url parameter --${field.name}. Usage: ${usageForCommand(command)}`,
        );
      }
      urlParams[field.name] = coerceByAst(value, field.ast);
    }
    request.urlParams = urlParams;
  }

  if (command.hasPayloadSchema) {
    const payloadJsonFlag = options.parsed.flags["payload-json"];
    if (typeof payloadJsonFlag === "string") {
      try {
        request.payload = JSON.parse(payloadJsonFlag) as unknown;
      } catch {
        throw new Error(`Invalid JSON in --payload-json for ${command.groupName}.${command.endpointName}`);
      }
      return request;
    }

    if (command.payloadFields.length > 0) {
      const payload: Record<string, unknown> = {};
      for (const field of command.payloadFields) {
        const value = options.parsed.flags[field.name];
        if (typeof value !== "string") {
          if (field.optional) {
            continue;
          }
          throw new Error(
            `Missing required payload field --${field.name}. Usage: ${usageForCommand(command)}`,
          );
        }
        payload[field.name] = coerceByAst(value, field.ast);
      }
      request.payload = payload;
    }
  }

  return request;
};

export const fromApi = (
  api: HttpApi.HttpApi.Any,
): HttpApiCli => {
  const commands = buildCommandList(api);
  const commandByKey = new Map<string, EndpointCommand>();

  for (const command of commands) {
    commandByKey.set(`${command.groupName}:${command.endpointCliName}`, command);
    commandByKey.set(`${command.groupName}:${command.endpointName}`, command);
  }

  const helpText = [
    "HttpApi-derived commands:",
    ...commands
      .sort((left, right) => {
        const groupSort = left.groupName.localeCompare(right.groupName);
        if (groupSort !== 0) {
          return groupSort;
        }
        return left.endpointCliName.localeCompare(right.endpointCliName);
      })
      .map((command) =>
        `  ${command.groupName} ${command.endpointCliName}  (${command.method} ${command.path})`,
      ),
  ].join("\n");

  return {
    helpText,
    commands,
    execute: async (input) => {
      const command = commandByKey.get(`${input.groupName}:${input.endpointName}`);
      if (!command) {
        return false;
      }

      const request = await buildRequestObject(command, {
        parsed: {
          positional: [input.groupName, input.endpointName],
          flags: input.flags,
        },
        invoke: input.invoke,
        print: input.print,
        resolveDefaultPathValue: input.resolveDefaultPathValue,
      });
      const result = await input.invoke({ request, command });
      input.print(result);
      return true;
    },
    run: async (options) => {
      const [groupName, endpointName] = options.parsed.positional;
      if (!groupName || !endpointName) {
        return false;
      }

      const command = commandByKey.get(`${groupName}:${endpointName}`);
      if (!command) {
        return false;
      }

      const request = await buildRequestObject(command, options);
      const result = await options.invoke({
        request,
        command,
      });
      options.print(result);
      return true;
    },
  };
};
