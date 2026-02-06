import { createCodeModeRunner } from "@openassistant/core";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type MessageCreateOptions,
  Partials,
} from "discord.js";
import { Effect } from "effect";
import { DiscordApprovalBridge } from "./approval-bridge.js";
import { InMemoryCalendarStore } from "./calendar-store.js";
import { generateCodeFromPrompt } from "./codegen.js";
import { formatDiscordResponse } from "./format-response.js";
import { createToolTree } from "./tools.js";

const token = Bun.env.DISCORD_BOT_TOKEN;
if (!token) {
  throw new Error("Missing DISCORD_BOT_TOKEN");
}

const approvalTimeoutMs = Number(Bun.env.OPENASSISTANT_APPROVAL_TIMEOUT_MS ?? 300_000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const approvalBridge = new DiscordApprovalBridge(approvalTimeoutMs);
const calendarStore = new InMemoryCalendarStore();
const tools = createToolTree(calendarStore);

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[discord-bot] logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) {
    return;
  }
  await approvalBridge.handleInteraction(interaction);
});

client.on(Events.MessageCreate, async (message) => {
  if (shouldIgnore(message)) {
    return;
  }
  await handleMessage(message);
});

await client.login(token);

function shouldIgnore(message: Message): boolean {
  return message.author.bot || message.content.trim().length === 0 || message.channel.type !== ChannelType.DM;
}

async function handleMessage(message: Message): Promise<void> {
  const ack = await message.reply("Working on it...");
  const approvalChannel = message.channel as unknown;
  if (
    !approvalChannel ||
    typeof approvalChannel !== "object" ||
    !("send" in approvalChannel) ||
    typeof (approvalChannel as { send?: unknown }).send !== "function"
  ) {
    await ack.edit("This channel does not support approval prompts.");
    return;
  }

  const generated = await generateCodeFromPrompt(message.content);

  const runner = createCodeModeRunner({
    tools,
    requestApproval: (request) =>
      Effect.tryPromise({
        try: () =>
          approvalBridge.requestApproval({
            request,
            channel: approvalChannel as { send: (message: MessageCreateOptions) => Promise<unknown> },
            requesterId: message.author.id,
          }),
        catch: (error) => error,
      }),
  });

  const result = await Effect.runPromise(runner.run({ code: generated.code }));
  const response = formatDiscordResponse({
    prompt: message.content,
    generatedCode: generated.code,
    rationale: generated.rationale,
    provider: generated.provider,
    result,
  });

  await ack.edit(response);
}
