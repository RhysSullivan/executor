/**
 * OpenAssistant Discord Bot
 *
 * Connects to Discord, registers slash commands, and renders
 * task results using Reacord (React for Discord).
 *
 * Communicates with the server via Eden Treaty (type-safe HTTP client).
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { makeReacord } from "@openassistant/reacord";
import { createClient } from "@openassistant/server/client";
import { handleAskCommand } from "./commands/ask";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DISCORD_TOKEN = process.env["DISCORD_BOT_TOKEN"];
if (!DISCORD_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN is required");
}

const SERVER_URL = process.env["OPENASSISTANT_SERVER_URL"] ?? "http://localhost:3000";

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

// ---------------------------------------------------------------------------
// Reacord
// ---------------------------------------------------------------------------

const reacord = makeReacord(client, { maxInstances: 50 });

// ---------------------------------------------------------------------------
// Eden Treaty API client
// ---------------------------------------------------------------------------

const api = createClient(SERVER_URL);

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the AI assistant to do something")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("What do you want the assistant to do?")
        .setRequired(true),
    ),
];

// ---------------------------------------------------------------------------
// Register commands on startup
// ---------------------------------------------------------------------------

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
      await handleAskCommand(interaction, { api, reacord });
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
});

client.login(DISCORD_TOKEN);
