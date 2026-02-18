import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Message,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { createClient, unwrap } from "@assistant/server/client";

type ChatIdentity = {
  readonly platform: "discord";
  readonly userId: string;
};

const SERVER_URL = Bun.env.ASSISTANT_SERVER_URL ?? `http://localhost:${Bun.env.ASSISTANT_PORT ?? "3002"}`;
const DISCORD_TOKEN = Bun.env.DISCORD_TOKEN ?? Bun.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = Bun.env.DISCORD_GUILD_ID;
const COMMAND_PREFIX = Bun.env.ASSISTANT_COMMAND_PREFIX ?? "!";
const EXECUTOR_WEB_URL = Bun.env.EXECUTOR_WEB_URL
  ?? Bun.env.OPENASSISTANT_EXECUTOR_WEB_URL
  ?? Bun.env.OPENASSISTANT_EXECUTOR_URL
  ?? "http://localhost:3000";

if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_TOKEN (or DISCORD_BOT_TOKEN) is required");
}
const BOT_TOKEN = DISCORD_TOKEN;

const api = createClient(SERVER_URL);
const subscribedChannels = new Set<string>();

const LINK_MODAL_ID = "assistant_link_workos_modal";
const LINK_OPEN_MODAL_BUTTON_ID = "assistant_link_workos_open_modal";
const LINK_FIELD_WORKSPACE = "workspace_id";
const LINK_FIELD_TOKEN = "access_token";
const LINK_FIELD_ACCOUNT = "account_id";
const ANON_LINK_MODAL_ID = "assistant_link_anonymous_modal";
const ANON_LINK_FIELD_WORKSPACE = "workspace_id";
const ANON_LINK_FIELD_API_KEY = "api_key";
const ELICITATION_BUTTON_PREFIX = "assistant_elicitation";
const ELICITATION_FORM_MODAL_PREFIX = "assistant_elicitation_form";
const ELICITATION_POLL_INTERVAL_MS = 1000;
const ELICITATION_FORM_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_DISCORD_MODAL_FIELDS = 5;

type ElicitationAction = "accept" | "decline" | "cancel";
type ElicitationButtonAction = ElicitationAction | "form";

type FormFieldKind = "string" | "number" | "integer" | "boolean" | "enum_single" | "enum_multi";

interface EnumOption {
  readonly value: string | number | boolean;
  readonly title?: string;
}

interface FormFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  readonly kind: FormFieldKind;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly options?: readonly EnumOption[];
  readonly defaultValue?: string | number | boolean | readonly (string | number | boolean)[];
}

interface FormSchemaSpec {
  readonly fields: readonly FormFieldSpec[];
  readonly error?: string;
}

interface FormModalSession {
  readonly requestId: string;
  readonly elicitationRequestId: string;
  readonly userId: string;
  readonly fields: readonly FormFieldSpec[];
  readonly timeout: ReturnType<typeof setTimeout>;
}

interface PendingElicitation {
  readonly id: string;
  readonly requestId: string;
  readonly mode: "form" | "url";
  readonly message: string;
  readonly requestedSchema?: Record<string, unknown>;
  readonly url?: string;
  readonly elicitationId?: string;
  readonly createdAt: number;
}

const knownElicitations = new Map<string, PendingElicitation>();
const knownElicitationIdsByRequest = new Map<string, Set<string>>();
const formModalSessions = new Map<string, FormModalSession>();

const slashCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the assistant in your linked context")
    .addStringOption((option) => option
      .setName("prompt")
      .setDescription("What you want the assistant to do")
      .setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("whoami")
    .setDescription("Show your current linked MCP context")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("link-workos")
    .setDescription("Link this Discord user to a WorkOS MCP context")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("link-anon")
    .setDescription("Link to an anonymous MCP API key")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Remove your saved MCP link")
    .toJSON(),
];

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

function identityFromUser(userId: string): ChatIdentity {
  return {
    platform: "discord",
    userId,
  };
}

function truncate(value: string, max = 3500): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function chunkMessage(text: string, max = 1800): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const splitAt = remaining.lastIndexOf("\n", max);
    const end = splitAt > max * 0.4 ? splitAt : max;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function reply(message: Message<boolean>, text: string) {
  const normalized = truncate(text, 12_000);
  const chunks = chunkMessage(normalized);
  for (const chunk of chunks) {
    await message.reply(chunk);
  }
}

function commandParts(text: string): readonly string[] {
  return text.trim().split(/\s+/).filter((part) => part.length > 0);
}

function stripBotMention(text: string, botUserId: string): string {
  return text
    .replaceAll(`<@${botUserId}>`, "")
    .replaceAll(`<@!${botUserId}>`, "")
    .trim();
}

function isCommand(text: string): boolean {
  return text.startsWith(COMMAND_PREFIX);
}

function parseCommand(text: string): { command: string; args: readonly string[] } {
  const withoutPrefix = text.slice(COMMAND_PREFIX.length).trim();
  const [command = "", ...args] = commandParts(withoutPrefix);
  return {
    command: command.toLowerCase(),
    args,
  };
}

async function getContext(identity: ChatIdentity) {
  const data = await unwrap(
    api.api.context.resolve.post({
      platform: identity.platform,
      userId: identity.userId,
    }),
  );
  return data.context;
}

async function linkWorkos(identity: ChatIdentity, workspaceId: string, accessToken: string, accountId?: string) {
  const data = await unwrap(
    api.api.context.link.post({
      platform: identity.platform,
      userId: identity.userId,
      provider: "workos",
      workspaceId,
      accessToken,
      accountId,
    }),
  );
  return data.context;
}

async function linkAnonymous(identity: ChatIdentity, workspaceId: string, apiKey: string) {
  const data = await unwrap(
    api.api.context.link.post({
      platform: identity.platform,
      userId: identity.userId,
      provider: "anonymous",
      workspaceId,
      apiKey,
    }),
  );
  return data.context;
}

async function unlink(identity: ChatIdentity) {
  const data = await unwrap(
    api.api.context.unlink.post({
      platform: identity.platform,
      userId: identity.userId,
    }),
  );
  return data.removed;
}

async function runPrompt(identity: ChatIdentity, prompt: string, requestId?: string) {
  const data = await unwrap(
    api.api.chat.run.post({
      platform: identity.platform,
      userId: identity.userId,
      prompt,
      requestId,
    }),
  );
  return data;
}

async function getPendingElicitation(identity: ChatIdentity, requestId: string): Promise<PendingElicitation | null> {
  const data = await unwrap(
    api.api.chat.elicitation.pending.post({
      platform: identity.platform,
      userId: identity.userId,
      requestId,
    }),
  );
  return data.elicitation;
}

async function respondToElicitation(
  identity: ChatIdentity,
  requestId: string,
  elicitationRequestId: string,
  action: ElicitationAction,
  content?: Record<string, unknown>,
) {
  return await unwrap(
    api.api.chat.elicitation.respond.post({
      platform: identity.platform,
      userId: identity.userId,
      requestId,
      elicitationRequestId,
      action,
      content,
    }),
  );
}

function randomRequestId(): string {
  return crypto.randomUUID();
}

function elicitationKey(requestId: string, elicitationId: string): string {
  return `${requestId}:${elicitationId}`;
}

function rememberElicitation(elicitation: PendingElicitation) {
  knownElicitations.set(elicitationKey(elicitation.requestId, elicitation.id), elicitation);
  const existing = knownElicitationIdsByRequest.get(elicitation.requestId) ?? new Set<string>();
  existing.add(elicitation.id);
  knownElicitationIdsByRequest.set(elicitation.requestId, existing);
}

function forgetElicitation(requestId: string, elicitationId: string) {
  knownElicitations.delete(elicitationKey(requestId, elicitationId));
  const ids = knownElicitationIdsByRequest.get(requestId);
  if (!ids) {
    return;
  }
  ids.delete(elicitationId);
  if (ids.size === 0) {
    knownElicitationIdsByRequest.delete(requestId);
  }
}

function forgetRequestElicitations(requestId: string) {
  const ids = knownElicitationIdsByRequest.get(requestId);
  if (!ids) {
    return;
  }
  for (const id of ids) {
    knownElicitations.delete(elicitationKey(requestId, id));
  }
  knownElicitationIdsByRequest.delete(requestId);
}

function getKnownElicitation(requestId: string, elicitationId: string): PendingElicitation | null {
  return knownElicitations.get(elicitationKey(requestId, elicitationId)) ?? null;
}

function buildElicitationButtonId(action: ElicitationButtonAction, requestId: string, elicitationId: string): string {
  return `${ELICITATION_BUTTON_PREFIX}:${action}:${requestId}:${elicitationId}`;
}

function parseElicitationButtonId(customId: string): {
  action: ElicitationButtonAction;
  requestId: string;
  elicitationRequestId: string;
} | null {
  const [prefix, action, requestId, elicitationRequestId] = customId.split(":");
  if (prefix !== ELICITATION_BUTTON_PREFIX) {
    return null;
  }
  if (action !== "accept" && action !== "decline" && action !== "cancel" && action !== "form") {
    return null;
  }
  if (!requestId || !elicitationRequestId) {
    return null;
  }
  return {
    action,
    requestId,
    elicitationRequestId,
  };
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function parseEnumOptions(property: Record<string, unknown>): EnumOption[] | null {
  const enumValues = Array.isArray(property.enum)
    ? property.enum.filter((value) => ["string", "number", "boolean"].includes(typeof value)) as Array<string | number | boolean>
    : null;
  if (enumValues && enumValues.length > 0) {
    return enumValues.map((value) => ({ value }));
  }

  const variantsRaw = Array.isArray(property.oneOf)
    ? property.oneOf
    : Array.isArray(property.anyOf)
      ? property.anyOf
      : null;

  if (!variantsRaw || variantsRaw.length === 0) {
    return null;
  }

  const variants: EnumOption[] = [];
  for (const variant of variantsRaw) {
    const parsed = parseObject(variant);
    if (!parsed || !("const" in parsed)) {
      return null;
    }
    const value = parsed.const;
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return null;
    }
    const title = typeof parsed.title === "string" ? parsed.title : undefined;
    variants.push({ value: value as string | number | boolean, title });
  }

  return variants;
}

function toFieldSpec(
  key: string,
  property: Record<string, unknown>,
  requiredSet: ReadonlySet<string>,
): FormFieldSpec | null {
  const type = typeof property.type === "string" ? property.type : undefined;
  const options = parseEnumOptions(property);

  if (type === "array") {
    const items = parseObject(property.items);
    const itemOptions = items ? parseEnumOptions(items) : null;
    if (!itemOptions || itemOptions.length === 0) {
      return null;
    }
    return {
      key,
      label: typeof property.title === "string" ? property.title.slice(0, 45) : key.slice(0, 45),
      description: typeof property.description === "string" ? property.description : undefined,
      required: requiredSet.has(key),
      kind: "enum_multi",
      options: itemOptions,
      minItems: typeof property.minItems === "number" ? property.minItems : undefined,
      maxItems: typeof property.maxItems === "number" ? property.maxItems : undefined,
      defaultValue: Array.isArray(property.default)
        ? property.default.filter((value) => ["string", "number", "boolean"].includes(typeof value)) as Array<string | number | boolean>
        : undefined,
    };
  }

  const kind: FormFieldKind | null = (() => {
    if (options && options.length > 0) {
      return "enum_single";
    }
    if (type === "string") return "string";
    if (type === "number") return "number";
    if (type === "integer") return "integer";
    if (type === "boolean") return "boolean";
    return null;
  })();

  if (!kind) {
    return null;
  }

  const defaultValue = ["string", "number", "boolean"].includes(typeof property.default)
    ? property.default as string | number | boolean
    : undefined;

  return {
    key,
    label: typeof property.title === "string" ? property.title.slice(0, 45) : key.slice(0, 45),
    description: typeof property.description === "string" ? property.description : undefined,
    required: requiredSet.has(key),
    kind,
    minLength: typeof property.minLength === "number" ? property.minLength : undefined,
    maxLength: typeof property.maxLength === "number" ? property.maxLength : undefined,
    pattern: typeof property.pattern === "string" ? property.pattern : undefined,
    minimum: typeof property.minimum === "number" ? property.minimum : undefined,
    maximum: typeof property.maximum === "number" ? property.maximum : undefined,
    options: options ?? undefined,
    defaultValue,
  };
}

function parseFormSchema(requestedSchema?: Record<string, unknown>): FormSchemaSpec {
  const schema = parseObject(requestedSchema);
  if (!schema) {
    return { fields: [], error: "Missing or invalid form schema." };
  }

  if (schema.type !== "object") {
    return { fields: [], error: "Form schema must be an object." };
  }

  const properties = parseObject(schema.properties);
  if (!properties) {
    return { fields: [], error: "Form schema is missing properties." };
  }

  const requiredSet = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  const keys = Object.keys(properties);
  if (keys.length === 0) {
    return { fields: [], error: "Form schema has no fields." };
  }
  if (keys.length > MAX_DISCORD_MODAL_FIELDS) {
    return {
      fields: [],
      error: `Discord modals support up to ${MAX_DISCORD_MODAL_FIELDS} fields, but schema requested ${keys.length}.`,
    };
  }

  const fields: FormFieldSpec[] = [];
  for (const key of keys) {
    const property = parseObject(properties[key]);
    if (!property) {
      return { fields: [], error: `Field '${key}' has an invalid schema.` };
    }

    const spec = toFieldSpec(key, property, requiredSet);
    if (!spec) {
      return { fields: [], error: `Field '${key}' uses an unsupported schema shape for Discord input.` };
    }
    fields.push(spec);
  }

  return { fields };
}

function enumOptionLabel(option: EnumOption): string {
  if (option.title && option.title.trim().length > 0) {
    return `${option.title} (${String(option.value)})`;
  }
  return String(option.value);
}

function toTextInputDefault(field: FormFieldSpec): string | undefined {
  if (field.defaultValue === undefined) {
    return undefined;
  }
  if (Array.isArray(field.defaultValue)) {
    return field.defaultValue.map((value) => String(value)).join(", ");
  }
  return String(field.defaultValue);
}

function toTextInputPlaceholder(field: FormFieldSpec): string | undefined {
  const optionsHint = field.options && field.options.length > 0
    ? `Options: ${field.options.map(enumOptionLabel).join(", ")}`
    : undefined;
  const boolHint = field.kind === "boolean" ? "Enter true/false" : undefined;

  const description = field.description?.trim();
  const joined = [description, optionsHint, boolHint]
    .filter((value): value is string => Boolean(value && value.length > 0))
    .join(" | ");

  if (!joined) {
    return undefined;
  }
  return joined.slice(0, 100);
}

function createFormModalSession(elicitation: PendingElicitation, userId: string): {
  modal?: ModalBuilder;
  error?: string;
} {
  const parsed = parseFormSchema(elicitation.requestedSchema);
  if (parsed.error) {
    return { error: parsed.error };
  }

  const fields = parsed.fields;
  if (fields.length === 0) {
    return { error: "No supported fields were found in this form." };
  }

  const modalId = `${ELICITATION_FORM_MODAL_PREFIX}:${crypto.randomUUID()}`;
  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle("MCP Elicitation Form");

  fields.forEach((field, index) => {
    const input = new TextInputBuilder()
      .setCustomId(`f_${index}`)
      .setLabel(field.label)
      .setStyle(TextInputStyle.Short)
      .setRequired(field.required);

    const defaultValue = toTextInputDefault(field);
    if (defaultValue) {
      input.setValue(defaultValue.slice(0, 4000));
    }

    const placeholder = toTextInputPlaceholder(field);
    if (placeholder) {
      input.setPlaceholder(placeholder);
    }

    if (field.kind === "string" && (field.maxLength ?? 0) > 120) {
      input.setStyle(TextInputStyle.Paragraph);
    }

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  });

  const timeout = setTimeout(() => {
    formModalSessions.delete(modalId);
  }, ELICITATION_FORM_SESSION_TIMEOUT_MS);

  formModalSessions.set(modalId, {
    requestId: elicitation.requestId,
    elicitationRequestId: elicitation.id,
    userId,
    fields,
    timeout,
  });

  return { modal };
}

function consumeFormModalSession(modalId: string): FormModalSession | null {
  const session = formModalSessions.get(modalId);
  if (!session) {
    return null;
  }
  clearTimeout(session.timeout);
  formModalSessions.delete(modalId);
  return session;
}

function parseBooleanInput(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (["true", "yes", "y", "1", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "n", "0", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseEnumValue(input: string, field: FormFieldSpec): { value?: string | number | boolean; error?: string } {
  const options = field.options ?? [];
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { error: `Field '${field.key}' cannot be empty.` };
  }

  const matching = options.find((option) => {
    const valueText = String(option.value);
    const titleText = option.title ?? "";
    return valueText === trimmed || titleText.toLowerCase() === trimmed.toLowerCase();
  });

  if (!matching) {
    return {
      error: `Field '${field.key}' must match one of: ${options.map(enumOptionLabel).join(", ")}`,
    };
  }

  return { value: matching.value };
}

function parseFormFieldValue(field: FormFieldSpec, rawInput: string): { value?: unknown; error?: string; skip?: true } {
  const raw = rawInput.trim();
  if (raw.length === 0) {
    if (field.required) {
      return { error: `Field '${field.key}' is required.` };
    }
    return { skip: true };
  }

  switch (field.kind) {
    case "string": {
      if (field.minLength !== undefined && raw.length < field.minLength) {
        return { error: `Field '${field.key}' must be at least ${field.minLength} characters.` };
      }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        return { error: `Field '${field.key}' must be at most ${field.maxLength} characters.` };
      }
      if (field.pattern) {
        const regex = new RegExp(field.pattern);
        if (!regex.test(raw)) {
          return { error: `Field '${field.key}' does not match required format.` };
        }
      }
      return { value: raw };
    }

    case "number":
    case "integer": {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        return { error: `Field '${field.key}' must be a number.` };
      }
      if (field.kind === "integer" && !Number.isInteger(parsed)) {
        return { error: `Field '${field.key}' must be an integer.` };
      }
      if (field.minimum !== undefined && parsed < field.minimum) {
        return { error: `Field '${field.key}' must be >= ${field.minimum}.` };
      }
      if (field.maximum !== undefined && parsed > field.maximum) {
        return { error: `Field '${field.key}' must be <= ${field.maximum}.` };
      }
      return { value: parsed };
    }

    case "boolean": {
      const parsed = parseBooleanInput(raw);
      if (parsed === null) {
        return { error: `Field '${field.key}' must be true/false.` };
      }
      return { value: parsed };
    }

    case "enum_single": {
      return parseEnumValue(raw, field);
    }

    case "enum_multi": {
      const valuesRaw = raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

      if (field.minItems !== undefined && valuesRaw.length < field.minItems) {
        return { error: `Field '${field.key}' must include at least ${field.minItems} value(s).` };
      }
      if (field.maxItems !== undefined && valuesRaw.length > field.maxItems) {
        return { error: `Field '${field.key}' must include at most ${field.maxItems} value(s).` };
      }

      const parsed: Array<string | number | boolean> = [];
      for (const valueRaw of valuesRaw) {
        const value = parseEnumValue(valueRaw, field);
        if (value.error) {
          return value;
        }
        parsed.push(value.value!);
      }
      return { value: parsed };
    }
  }
}

function parseFormModalValues(
  fields: readonly FormFieldSpec[],
  getFieldValue: (fieldId: string) => string,
): { content?: Record<string, unknown>; error?: string } {
  const content: Record<string, unknown> = {};

  for (const [index, field] of fields.entries()) {
    const rawInput = getFieldValue(`f_${index}`);
    const parsed = parseFormFieldValue(field, rawInput);
    if (parsed.error) {
      return { error: parsed.error };
    }
    if (!parsed.skip) {
      content[field.key] = parsed.value;
    }
  }

  return { content };
}

function createElicitationButtons(elicitation: PendingElicitation) {
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (elicitation.mode === "url") {
    if (elicitation.url) {
      try {
        row.addComponents(
          new ButtonBuilder()
            .setLabel("Open URL")
            .setStyle(ButtonStyle.Link)
            .setURL(elicitation.url),
        );
      } catch {
        // Ignore malformed URLs and keep decision buttons available.
      }
    }

    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildElicitationButtonId("accept", elicitation.requestId, elicitation.id))
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
    );
  }

  if (elicitation.mode === "form") {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(buildElicitationButtonId("form", elicitation.requestId, elicitation.id))
        .setLabel("Fill Form")
        .setStyle(ButtonStyle.Primary),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(buildElicitationButtonId("decline", elicitation.requestId, elicitation.id))
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(buildElicitationButtonId("cancel", elicitation.requestId, elicitation.id))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  return [row];
}

function formatElicitationMessage(elicitation: PendingElicitation): string {
  const lines = [
    `MCP elicitation request (${elicitation.mode})`,
    elicitation.message,
  ];

  if (elicitation.mode === "url" && elicitation.url) {
    lines.push(`Open URL if approved: ${elicitation.url}`);
  }

  if (elicitation.mode === "form") {
    lines.push("Click Fill Form to provide values, or deny/cancel.");
  }

  return lines.join("\n");
}

async function runPromptWithElicitations(
  identity: ChatIdentity,
  prompt: string,
  onElicitation: (elicitation: PendingElicitation) => Promise<void>,
) {
  const requestId = randomRequestId();
  let done = false;
  const seen = new Set<string>();

  const runPromise = runPrompt(identity, prompt, requestId);
  const pollPromise = (async () => {
    while (!done) {
      try {
        const pending = await getPendingElicitation(identity, requestId);
        if (pending && !seen.has(pending.id)) {
          seen.add(pending.id);
          rememberElicitation(pending);
          await onElicitation(pending);
        }
      } catch {
        // Best effort polling: do not interrupt active prompt run.
      }

      await Bun.sleep(ELICITATION_POLL_INTERVAL_MS);
    }
  })();

  try {
    return await runPromise;
  } finally {
    done = true;
    await pollPromise.catch(() => {});
    forgetRequestElicitations(requestId);
  }
}

function contextLabel(context: {
  source: string;
  workspaceId: string;
  accountId?: string;
  sessionId?: string;
  hasAccessToken: boolean;
  hasApiKey?: boolean;
}) {
  const authMode = context.hasApiKey ? "api-key" : context.hasAccessToken ? "token" : "session";
  return [
    `source=${context.source}`,
    `workspace=${context.workspaceId}`,
    context.accountId ? `account=${context.accountId}` : undefined,
    context.sessionId ? `session=${context.sessionId}` : undefined,
    `auth=${authMode}`,
  ]
    .filter(Boolean)
    .join(" | ");
}

function createWorkosLinkModal() {
  const modal = new ModalBuilder()
    .setCustomId(LINK_MODAL_ID)
    .setTitle("Link WorkOS MCP Context");

  const workspaceInput = new TextInputBuilder()
    .setCustomId(LINK_FIELD_WORKSPACE)
    .setLabel("Workspace ID")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("e.g. j57...workspace id");

  const tokenInput = new TextInputBuilder()
    .setCustomId(LINK_FIELD_TOKEN)
    .setLabel("Access Token")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setPlaceholder("Paste MCP bearer token");

  const accountInput = new TextInputBuilder()
    .setCustomId(LINK_FIELD_ACCOUNT)
    .setLabel("Account ID (optional)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder("Optional override");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(workspaceInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(tokenInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(accountInput),
  );

  return modal;
}

function createAnonymousLinkModal() {
  const modal = new ModalBuilder()
    .setCustomId(ANON_LINK_MODAL_ID)
    .setTitle("Link Anonymous MCP Context");

  const workspaceInput = new TextInputBuilder()
    .setCustomId(ANON_LINK_FIELD_WORKSPACE)
    .setLabel("Workspace ID")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder("Paste workspace id from dashboard");

  const apiKeyInput = new TextInputBuilder()
    .setCustomId(ANON_LINK_FIELD_API_KEY)
    .setLabel("MCP API Key")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setPlaceholder("Paste API key from dashboard");

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(workspaceInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput),
  );

  return modal;
}

function buildExecutorLink(identity: ChatIdentity): string | null {
  try {
    const url = new URL(EXECUTOR_WEB_URL);
    url.searchParams.set("source", "discord-bot-link");
    url.searchParams.set("discord_user", identity.userId);
    return url.toString();
  } catch {
    return null;
  }
}

function buildLinkWorkosPanel(identity: ChatIdentity) {
  const executorLink = buildExecutorLink(identity);
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (executorLink) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Open Executor")
        .setStyle(ButtonStyle.Link)
        .setURL(executorLink),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(LINK_OPEN_MODAL_BUTTON_ID)
      .setLabel("Paste Workspace + Token")
      .setStyle(ButtonStyle.Primary),
  );

  const instructions = [
    "Link your WorkOS account in 2 quick steps:",
    "1) Open Executor and sign in. Find your MCP workspace/token there.",
    "2) Click 'Paste Workspace + Token' and submit the private modal.",
    executorLink ? `Executor: ${executorLink}` : "Set EXECUTOR_WEB_URL to include a direct Executor link.",
  ].join("\n");

  return {
    content: instructions,
    components: [row],
  };
}

async function registerSlashCommands() {
  const appId = bot.user?.id;
  if (!appId) return;

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);

  if (DISCORD_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(appId, DISCORD_GUILD_ID),
      { body: slashCommands },
    );
    console.log(`[assistant-bot] registered guild slash commands in ${DISCORD_GUILD_ID}`);
    return;
  }

  await rest.put(
    Routes.applicationCommands(appId),
    { body: slashCommands },
  );
  console.log("[assistant-bot] registered global slash commands");
}

async function handlePrefixCommand(message: Message<boolean>, rawText: string) {
  const { command, args } = parseCommand(rawText);
  const identity = identityFromUser(message.author.id);

  if (!command || command === "help") {
    await reply(message, [
      "Assistant commands:",
      "- /ask <prompt>",
      "- /whoami",
      "- /link-workos (opens secure modal)",
      "- /link-anon (paste workspace + API key)",
      "- /unlink",
      `Prefix fallback: ${COMMAND_PREFIX}whoami, ${COMMAND_PREFIX}link-anon <workspaceId> <apiKey>, ${COMMAND_PREFIX}unlink`,
    ].join("\n"));
    return;
  }

  if (command === "whoami") {
    const context = await getContext(identity);
    await reply(message, `Current MCP context: ${contextLabel(context)}`);
    return;
  }

  if (command === "unlink") {
    const removed = await unlink(identity);
    await reply(message, removed ? "Link removed. You are back to anonymous context." : "No saved link found.");
    return;
  }

  if (command === "link-anon") {
    const [workspaceId, apiKey] = args;
    if (!workspaceId || !apiKey) {
      await reply(message, `Usage: ${COMMAND_PREFIX}link-anon <workspaceId> <apiKey>`);
      return;
    }
    const context = await linkAnonymous(identity, workspaceId, apiKey);
    await reply(message, `Linked anonymous context: ${contextLabel(context)}`);
    return;
  }

  if (command === "link-workos") {
    const panel = buildLinkWorkosPanel(identity);
    await reply(message, `${panel.content}\nUse /link-workos to open the button panel in an ephemeral response.`);
    return;
  }

  await reply(message, `Unknown command '${command}'. Run /help or ${COMMAND_PREFIX}help.`);
}

bot.once("clientReady", async () => {
  console.log(`[assistant-bot] discord bot online as ${bot.user?.tag ?? "unknown"} (server: ${SERVER_URL})`);
  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("[assistant-bot] failed to register slash commands", error);
  }
});

bot.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const identity = identityFromUser(interaction.user.id);

      if (interaction.commandName === "ask") {
        const prompt = interaction.options.getString("prompt", true);
        await interaction.deferReply();
        const result = await runPromptWithElicitations(identity, prompt, async (elicitation) => {
          await interaction.followUp({
            content: formatElicitationMessage(elicitation),
            components: createElicitationButtons(elicitation),
            ephemeral: true,
          });
        });
        const chunks = chunkMessage(result.text || "Done.");
        await interaction.editReply(chunks[0] ?? "Done.");
        for (let i = 1; i < chunks.length; i += 1) {
          await interaction.followUp(chunks[i]!);
        }
        return;
      }

      if (interaction.commandName === "whoami") {
        const context = await getContext(identity);
        await interaction.reply({
          content: `Current MCP context: ${contextLabel(context)}`,
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "unlink") {
        const removed = await unlink(identity);
        await interaction.reply({
          content: removed ? "Link removed. You are back to anonymous context." : "No saved link found.",
          ephemeral: true,
        });
        return;
      }

      if (interaction.commandName === "link-anon") {
        await interaction.showModal(createAnonymousLinkModal());
        return;
      }

      if (interaction.commandName === "link-workos") {
        const panel = buildLinkWorkosPanel(identity);
        await interaction.reply({
          content: panel.content,
          components: panel.components,
          ephemeral: true,
        });
        return;
      }

      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === LINK_MODAL_ID) {
      const identity = identityFromUser(interaction.user.id);
      const workspaceId = interaction.fields.getTextInputValue(LINK_FIELD_WORKSPACE).trim();
      const accessToken = interaction.fields.getTextInputValue(LINK_FIELD_TOKEN).trim();
      const accountRaw = interaction.fields.getTextInputValue(LINK_FIELD_ACCOUNT).trim();
      const accountId = accountRaw.length > 0 ? accountRaw : undefined;

      if (!workspaceId || !accessToken) {
        await interaction.reply({
          content: "Workspace ID and access token are required.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const context = await linkWorkos(identity, workspaceId, accessToken, accountId);
      await interaction.editReply(`Linked WorkOS context: ${contextLabel(context)}`);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === ANON_LINK_MODAL_ID) {
      const identity = identityFromUser(interaction.user.id);
      const workspaceId = interaction.fields.getTextInputValue(ANON_LINK_FIELD_WORKSPACE).trim();
      const apiKey = interaction.fields.getTextInputValue(ANON_LINK_FIELD_API_KEY).trim();

      if (!workspaceId || !apiKey) {
        await interaction.reply({
          content: "Workspace ID and API key are required.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const context = await linkAnonymous(identity, workspaceId, apiKey);
      await interaction.editReply(`Linked anonymous context: ${contextLabel(context)}`);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(`${ELICITATION_FORM_MODAL_PREFIX}:`)) {
      const session = consumeFormModalSession(interaction.customId);
      if (!session) {
        await interaction.reply({
          content: "This elicitation form has expired. Click Fill Form again.",
          ephemeral: true,
        });
        return;
      }

      if (session.userId !== interaction.user.id) {
        await interaction.reply({
          content: "This form belongs to a different user.",
          ephemeral: true,
        });
        return;
      }

      const parsed = parseFormModalValues(
        session.fields,
        (fieldId) => interaction.fields.getTextInputValue(fieldId),
      );
      if (parsed.error || !parsed.content) {
        await interaction.reply({
          content: parsed.error ?? "Invalid form data. Click Fill Form and try again.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const identity = identityFromUser(interaction.user.id);
      const resolution = await respondToElicitation(
        identity,
        session.requestId,
        session.elicitationRequestId,
        "accept",
        parsed.content,
      );

      if (!resolution.ok) {
        await interaction.editReply(resolution.error ?? "Unable to resolve elicitation.");
        return;
      }

      forgetElicitation(session.requestId, session.elicitationRequestId);
      await interaction.editReply("Elicitation accepted.");
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(`${ELICITATION_BUTTON_PREFIX}:`)) {
      const parsed = parseElicitationButtonId(interaction.customId);
      if (!parsed) {
        await interaction.reply({
          content: "Invalid elicitation action.",
          ephemeral: true,
        });
        return;
      }

      if (parsed.action === "form") {
        const elicitation = getKnownElicitation(parsed.requestId, parsed.elicitationRequestId);
        if (!elicitation) {
          await interaction.reply({
            content: "This elicitation request is no longer available.",
            ephemeral: true,
          });
          return;
        }

        if (elicitation.mode !== "form") {
          await interaction.reply({
            content: "This elicitation is not a form request.",
            ephemeral: true,
          });
          return;
        }

        const modal = createFormModalSession(elicitation, interaction.user.id);
        if (!modal.modal) {
          await interaction.reply({
            content: modal.error ?? "Unable to render this form in Discord.",
            ephemeral: true,
          });
          return;
        }

        await interaction.showModal(modal.modal);
        return;
      }

      const identity = identityFromUser(interaction.user.id);
      const resolution = await respondToElicitation(
        identity,
        parsed.requestId,
        parsed.elicitationRequestId,
        parsed.action,
      );

      if (!resolution.ok) {
        await interaction.reply({
          content: resolution.error ?? "Unable to resolve elicitation.",
          ephemeral: true,
        });
        return;
      }

      forgetElicitation(parsed.requestId, parsed.elicitationRequestId);

      await interaction.update({
        content: `Elicitation ${parsed.action}.`,
        components: [],
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === LINK_OPEN_MODAL_BUTTON_ID) {
      await interaction.showModal(createWorkosLinkModal());
      return;
    }
  } catch (error) {
    const text = `Warning: ${truncate(error instanceof Error ? error.message : String(error), 1200)}`;

    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: text, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: text, ephemeral: true }).catch(() => {});
      }
    }
  }
});

bot.on("messageCreate", async (message) => {
  if (!message.inGuild() && message.channel.type !== ChannelType.DM) return;
  if (message.author.bot) return;

  const botUserId = bot.user?.id;
  if (!botUserId) return;

  const rawText = message.content?.trim() ?? "";
  if (!rawText && !message.mentions.users.has(botUserId)) return;

  const mentioned = message.mentions.users.has(botUserId);
  const subscribed = subscribedChannels.has(message.channelId);
  const command = isCommand(rawText);

  if (!mentioned && !subscribed && !command && message.channel.type !== ChannelType.DM) {
    return;
  }

  try {
    if (command) {
      await handlePrefixCommand(message, rawText);
      return;
    }

    let prompt = rawText;
    if (mentioned) {
      subscribedChannels.add(message.channelId);
      prompt = stripBotMention(rawText, botUserId);
      if (!prompt) {
        await reply(message, "I am listening. Send a prompt here, or use `/ask`.");
        return;
      }
    }

    await message.channel.sendTyping();
    const identity = identityFromUser(message.author.id);
    const result = await runPromptWithElicitations(identity, prompt, async (elicitation) => {
      await message.reply({
        content: formatElicitationMessage(elicitation),
        components: createElicitationButtons(elicitation),
      });
    });
    await reply(message, result.text || "Done.");
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await reply(message, `Warning: ${truncate(messageText, 1400)}`);
  }
});

await bot.login(BOT_TOKEN);
