import { makeReacord } from "@openassistant/reacord";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
  type SendableChannels,
} from "discord.js";
import { Effect } from "effect";
import { AssistantReplyView, AssistantWorkingView } from "./discord-views.js";
import { formatDiscordResponse } from "./format-response.js";
import { runGatewayTurn } from "./gateway-client.js";

const token = Bun.env.DISCORD_BOT_TOKEN;
if (!token) {
  throw new Error("Missing DISCORD_BOT_TOKEN");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const reacord = makeReacord(client);

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[discord-bot] logged in as ${readyClient.user.tag}`);
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
  const approvalChannel = asSendableChannel(message.channel);
  if (!approvalChannel) {
    await message.reply("This channel does not support assistant responses.");
    return;
  }

  const instance = await Effect.runPromise(
    reacord.send(approvalChannel, <AssistantWorkingView />, {
      reply: { messageReference: message.id },
    }),
  );

  try {
    const generated = await runGatewayTurn({
      prompt: message.content,
      requesterId: message.author.id,
      channelId: message.channelId,
    });

    const response = formatDiscordResponse({
      text: generated.message,
      footer: generated.footer,
    });

    instance.render(<AssistantReplyView message={response.message} footer={response.footer} />);
  } catch (error) {
    instance.render(
      <AssistantReplyView
        message={`I hit an unexpected error while processing that request: ${describeUnknown(error)}`}
      />,
    );
  }
}

function asSendableChannel(channel: unknown): SendableChannels | null {
  if (!channel || typeof channel !== "object") {
    return null;
  }
  if (!("send" in channel) || typeof (channel as { send?: unknown }).send !== "function") {
    return null;
  }
  return channel as SendableChannels;
}

function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
