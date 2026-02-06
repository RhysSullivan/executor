import type { ApprovalDecision, ApprovalRequest } from "@openassistant/core";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type MessageCreateOptions,
} from "discord.js";
import { ApprovalRegistry } from "./approval-registry.js";

const CUSTOM_ID_PREFIX = "oa.approval";

export class DiscordApprovalBridge {
  private readonly registry: ApprovalRegistry;

  constructor(timeoutMs: number = 5 * 60_000) {
    this.registry = new ApprovalRegistry(timeoutMs);
  }

  async requestApproval(params: {
    request: ApprovalRequest;
    channel: { send: (message: MessageCreateOptions) => Promise<unknown> };
    requesterId: string;
  }): Promise<ApprovalDecision> {
    const { request, channel, requesterId } = params;
    const pending = this.registry.open(request.callId, requesterId);

    try {
      const message: MessageCreateOptions = {
        content: [
          `Approval needed for \`${request.toolPath}\``,
          `Call ID: \`${request.callId}\``,
          request.inputPreview ? `Input: \`${request.inputPreview}\`` : null,
          "Only the requesting user can approve or deny.",
        ]
          .filter(Boolean)
          .join("\n"),
        components: [approvalButtons(request.callId)],
      };

      await channel.send(message);
    } catch {
      this.registry.cancel(request.callId, "denied");
    }

    return pending;
  }

  async handleInteraction(interaction: ButtonInteraction): Promise<boolean> {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) {
      return false;
    }

    const decision: ApprovalDecision = parsed.action === "approve" ? "approved" : "denied";
    const status = this.registry.resolve(parsed.callId, interaction.user.id, decision);

    if (status === "unauthorized") {
      await interaction.reply({
        content: "Only the requesting user can resolve this approval.",
        ephemeral: true,
      });
      return true;
    }

    if (status === "not_found") {
      await interaction.reply({
        content: "This approval is no longer pending.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.update({
      content: `Approval ${decision} by <@${interaction.user.id}> for \`${parsed.callId}\`.`,
      components: [],
    });
    return true;
  }
}

function approvalButtons(callId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:${callId}:approve`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}:${callId}:deny`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );
}

function parseCustomId(customId: string): { callId: string; action: "approve" | "deny" } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== CUSTOM_ID_PREFIX) {
    return null;
  }
  const callId = parts[1];
  if (!callId) {
    return null;
  }
  const action = parts[2];
  if (action !== "approve" && action !== "deny") {
    return null;
  }
  return { callId, action };
}
