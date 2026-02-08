import { randomUUID } from "node:crypto";
import type {
	Attachment,
	ButtonInteraction,
	ModalSubmitInteraction,
} from "discord.js";
import {
	FileUploadBuilder,
	LabelBuilder,
	ModalBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextDisplayBuilder,
	TextInputBuilder,
	TextInputStyle,
	UserSelectMenuBuilder,
} from "discord.js";
import { ReacordElement } from "../internal/element";
import type { ComponentInteraction } from "../internal/interaction";
import type { MessageOptions } from "../internal/message";
import { getOrCreateActionRow } from "../internal/message";
import { Node } from "../internal/node";

export interface TextInputField {
	type: "textInput";
	id: string;
	label: string;
	description?: string;
	style?: "short" | "paragraph";
	placeholder?: string;
	defaultValue?: string;
	required?: boolean;
	minLength?: number;
	maxLength?: number;
}

export interface StringSelectOption {
	label: string;
	value: string;
	description?: string;
	emoji?: string;
	default?: boolean;
}

export interface StringSelectField {
	type: "stringSelect";
	id: string;
	label: string;
	description?: string;
	placeholder?: string;
	options: StringSelectOption[];
	required?: boolean;
	minValues?: number;
	maxValues?: number;
}

export interface UserSelectField {
	type: "userSelect";
	id: string;
	label: string;
	description?: string;
	placeholder?: string;
	required?: boolean;
	minValues?: number;
	maxValues?: number;
	defaultUserIds?: string[];
}

export interface FileUploadField {
	type: "fileUpload";
	id: string;
	label: string;
	description?: string;
	required?: boolean;
	minValues?: number;
	maxValues?: number;
}

export interface TextDisplayField {
	type: "textDisplay";
	content: string;
}

export type ModalField =
	| TextInputField
	| StringSelectField
	| UserSelectField
	| FileUploadField
	| TextDisplayField;

export interface ModalFieldValues {
	getTextInput(id: string): string | undefined;
	getStringSelect(id: string): readonly string[] | undefined;
	getUserSelect(id: string): readonly string[] | undefined;
	getFileUpload(id: string): Attachment[] | undefined;
}

export interface ModalButtonProps {
	style?: "primary" | "secondary" | "success" | "danger";
	label?: string;
	emoji?: string;
	disabled?: boolean;
	modalTitle: string;
	fields: ModalField[];
	onSubmit: (
		values: ModalFieldValues,
		interaction: ModalSubmitInteraction,
	) => void | Promise<void>;
}

export function ModalButton(props: ModalButtonProps) {
	return (
		<ReacordElement props={props} createNode={(p) => new ModalButtonNode(p)}>
			<ReacordElement
				props={{}}
				createNode={() => new ModalButtonLabelNode({})}
			>
				{props.label}
			</ReacordElement>
		</ReacordElement>
	);
}

class ModalButtonNode extends Node<ModalButtonProps> {
	private buttonCustomId = randomUUID();
	private modalCustomId = randomUUID();

	override get text() {
		return "";
	}

	protected override modifyMessageOptionsInternal(
		options: MessageOptions,
	): void {
		getOrCreateActionRow(options).components.push({
			type: "button",
			customId: this.buttonCustomId,
			style: this.props.style ?? "secondary",
			disabled: this.props.disabled,
			emoji: this.props.emoji,
			label: this.children.findType(ModalButtonLabelNode)?.text,
		});
	}

	override handleComponentInteraction(interaction: ComponentInteraction) {
		if (
			interaction.type === "button" &&
			interaction.customId === this.buttonCustomId
		) {
			this.showModal(interaction.interaction);
			return true;
		}

		if (
			interaction.type === "modal" &&
			interaction.customId === this.modalCustomId
		) {
			const values = this.extractModalValues(interaction.interaction);
			Promise.resolve(this.props.onSubmit(values, interaction.interaction));
			return true;
		}

		return false;
	}

	private extractModalValues(
		interaction: ModalSubmitInteraction,
	): ModalFieldValues {
		return {
			getTextInput: (id: string) => {
				try {
					return interaction.fields.getTextInputValue(id);
				} catch {
					return undefined;
				}
			},
			getStringSelect: (id: string) => {
				const field = interaction.fields.fields.get(id);
				if (field && "values" in field) {
					return field.values;
				}
				return undefined;
			},
			getUserSelect: (id: string) => {
				const field = interaction.fields.fields.get(id);
				if (field && "values" in field) {
					return field.values;
				}
				return undefined;
			},
			getFileUpload: (id: string) => {
				const field = interaction.fields.fields.get(id);
				if (field && "attachments" in field) {
					return [...field.attachments.values()];
				}
				return undefined;
			},
		};
	}

	private showModal(interaction: ButtonInteraction): void {
		const modal = new ModalBuilder()
			.setCustomId(this.modalCustomId)
			.setTitle(this.props.modalTitle);

		for (const field of this.props.fields) {
			if (field.type === "textDisplay") {
				modal.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(field.content),
				);
				continue;
			}

			if (field.type === "textInput") {
				const textInput = new TextInputBuilder()
					.setCustomId(field.id)
					.setStyle(
						field.style === "paragraph"
							? TextInputStyle.Paragraph
							: TextInputStyle.Short,
					)
					.setRequired(field.required ?? true);

				if (field.placeholder) {
					textInput.setPlaceholder(field.placeholder);
				}
				if (field.defaultValue) {
					textInput.setValue(field.defaultValue);
				}
				if (field.minLength !== undefined) {
					textInput.setMinLength(field.minLength);
				}
				if (field.maxLength !== undefined) {
					textInput.setMaxLength(field.maxLength);
				}

				const label = new LabelBuilder()
					.setLabel(field.label)
					.setTextInputComponent(textInput);

				if (field.description) {
					label.setDescription(field.description);
				}

				modal.addLabelComponents(label);
				continue;
			}

			if (field.type === "stringSelect") {
				const select = new StringSelectMenuBuilder()
					.setCustomId(field.id)
					.setRequired(field.required ?? false);

				if (field.placeholder) {
					select.setPlaceholder(field.placeholder);
				}
				if (field.minValues !== undefined) {
					select.setMinValues(field.minValues);
				}
				if (field.maxValues !== undefined) {
					select.setMaxValues(field.maxValues);
				}

				for (const option of field.options) {
					const optionBuilder = new StringSelectMenuOptionBuilder()
						.setLabel(option.label)
						.setValue(option.value);

					if (option.description) {
						optionBuilder.setDescription(option.description);
					}
					if (option.emoji) {
						optionBuilder.setEmoji({ name: option.emoji });
					}
					if (option.default) {
						optionBuilder.setDefault(true);
					}

					select.addOptions(optionBuilder);
				}

				const label = new LabelBuilder()
					.setLabel(field.label)
					.setStringSelectMenuComponent(select);

				if (field.description) {
					label.setDescription(field.description);
				}

				modal.addLabelComponents(label);
				continue;
			}

			if (field.type === "userSelect") {
				const userSelect = new UserSelectMenuBuilder()
					.setCustomId(field.id)
					.setRequired(field.required ?? false);

				if (field.placeholder) {
					userSelect.setPlaceholder(field.placeholder);
				}
				if (field.minValues !== undefined) {
					userSelect.setMinValues(field.minValues);
				}
				if (field.maxValues !== undefined) {
					userSelect.setMaxValues(field.maxValues);
				}
				if (field.defaultUserIds && field.defaultUserIds.length > 0) {
					userSelect.setDefaultUsers(field.defaultUserIds);
				}

				const label = new LabelBuilder()
					.setLabel(field.label)
					.setUserSelectMenuComponent(userSelect);

				if (field.description) {
					label.setDescription(field.description);
				}

				modal.addLabelComponents(label);
				continue;
			}

			if (field.type === "fileUpload") {
				const fileUpload = new FileUploadBuilder()
					.setCustomId(field.id)
					.setRequired(field.required ?? false);

				if (field.minValues !== undefined) {
					fileUpload.setMinValues(field.minValues);
				}
				if (field.maxValues !== undefined) {
					fileUpload.setMaxValues(field.maxValues);
				}

				const label = new LabelBuilder()
					.setLabel(field.label)
					.setFileUploadComponent(fileUpload);

				if (field.description) {
					label.setDescription(field.description);
				}

				modal.addLabelComponents(label);
			}
		}

		interaction.showModal(modal);
	}
}

class ModalButtonLabelNode extends Node<Record<string, never>> {}
