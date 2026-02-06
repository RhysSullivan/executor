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
import { AgentSessionView } from "./agent-session-view.js";

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
  const replyChannel = asSendableChannel(message.channel);
  if (!replyChannel) {
    await message.reply("This channel does not support assistant responses.");
    return;
  }

  await Effect.runPromise(
    reacord.send(
      replyChannel,
      <AgentSessionView
        prompt={message.content}
        requesterId={message.author.id}
        channelId={message.channelId}
        approvalTimeoutMs={approvalTimeoutMs}
      />,
      {
        reply: { messageReference: message.id },
      },
    ),
  );
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
