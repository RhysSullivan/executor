import type {
	ButtonInteraction,
	ModalSubmitInteraction,
	StringSelectMenuInteraction,
	UserSelectMenuInteraction,
} from "discord.js";

export type ComponentInteraction =
	| ReacordButtonInteraction
	| ReacordSelectInteraction
	| ReacordUserSelectInteraction
	| ReacordModalInteraction;

export interface ReacordButtonInteraction {
	type: "button";
	customId: string;
	interaction: ButtonInteraction;
}

export interface ReacordSelectInteraction {
	type: "select";
	customId: string;
	values: string[];
	interaction: StringSelectMenuInteraction;
}

export interface ReacordUserSelectInteraction {
	type: "userSelect";
	customId: string;
	userIds: string[];
	interaction: UserSelectMenuInteraction;
}

export interface ReacordModalInteraction {
	type: "modal";
	customId: string;
	fields: Map<string, string>;
	interaction: ModalSubmitInteraction;
}
