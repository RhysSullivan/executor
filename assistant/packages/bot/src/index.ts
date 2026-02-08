/**
 * Assistant Discord Bot
 *
 * Connects to Discord, registers slash commands, and renders
 * task results using Reacord + Convex reactivity.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { makeReacord } from "@openassistant/reacord";
import { createClient } from "@assistant/server/client";
import { ConvexReactClient } from "convex/react";
import { handleAskCommand } from "./commands/ask";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DISCORD_TOKEN = Bun.env.DISCORD_BOT_TOKEN;
if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN is required");
}

const SERVER_URL = Bun.env.ASSISTANT_SERVER_URL ?? "http://localhost:3000";
const CONVEX_URL = Bun.env.CONVEX_URL ?? "http://127.0.0.1:3210";

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

const reacord = makeReacord(client, { maxInstances: 50 });
const api = createClient(SERVER_URL);
const convex = new ConvexReactClient(CONVEX_URL, {
  unsavedChangesWarning: false,
});

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI assistant to do something")
    .addStringOption((opt) =>
      opt.setName("prompt").setDescription("What do you want the assistant to do?").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Push chat history out of view"),
];

async function registerCommands() {
  const rest = new REST().setToken(DISCORD_TOKEN!);
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(client.user!.id), {
      body: commands.map((c) => c.toJSON()),
    });
    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case "ask":
      await handleAskCommand(interaction, { api, convex, reacord });
      break;
    case "clear":
      await interaction.reply({ content: `_${"\n".repeat(50)}_` });
      break;
    default:
      await interaction.reply({ content: `Unknown command: ${interaction.commandName}` });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await registerCommands();
  console.log(`Connected to server at ${SERVER_URL}`);
  console.log(`Convex at ${CONVEX_URL}`);
});

client.login(DISCORD_TOKEN);
