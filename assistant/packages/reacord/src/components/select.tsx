import { randomUUID } from "node:crypto";
import type { StringSelectMenuInteraction } from "discord.js";
import { ReacordElement } from "../internal/element";
import type { ComponentInteraction } from "../internal/interaction";
import type { MessageOptions, MessageSelectOptions } from "../internal/message";
import { getOrCreateActionRow } from "../internal/message";
import { Node } from "../internal/node";
import { OptionNode } from "./option";

export interface SelectProps {
	placeholder?: string;
	disabled?: boolean;
	minValues?: number;
	maxValues?: number;
	value?: string;
	values?: string[];
	onSelect?: (
		value: string,
		interaction: StringSelectMenuInteraction,
	) => void | Promise<void>;
	onSelectMultiple?: (
		values: string[],
		interaction: StringSelectMenuInteraction,
	) => void | Promise<void>;
	children?: React.ReactNode;
}

export function Select(props: SelectProps) {
	return (
		<ReacordElement props={props} createNode={(p) => new SelectNode(p)}>
			{props.children}
		</ReacordElement>
	);
}

class SelectNode extends Node<SelectProps> {
	private customId = randomUUID();

	override get text() {
		return "";
	}

	protected override modifyMessageOptionsInternal(
		options: MessageOptions,
	): void {
		const optionNodes = [...this.children].filter(
			(child): child is OptionNode => child instanceof OptionNode,
		);

		const selectedValues =
			this.props.values ?? (this.props.value ? [this.props.value] : undefined);

		const selectOptions: MessageSelectOptions = {
			type: "select",
			customId: this.customId,
			placeholder: this.props.placeholder,
			disabled: this.props.disabled,
			minValues: this.props.minValues,
			maxValues: this.props.maxValues,
			options: optionNodes.map((node) => node.getOptionData()),
			values: selectedValues,
		};

		getOrCreateActionRow(options, selectOptions).components.push(selectOptions);
	}

	override handleComponentInteraction(interaction: ComponentInteraction) {
		if (
			interaction.type === "select" &&
			interaction.customId === this.customId
		) {
			const selectedValue = interaction.values[0];
			if (this.props.onSelectMultiple) {
				Promise.resolve(
					this.props.onSelectMultiple(
						interaction.values,
						interaction.interaction,
					),
				);
			} else if (this.props.onSelect && selectedValue) {
				Promise.resolve(
					this.props.onSelect(selectedValue, interaction.interaction),
				);
			}
			return true;
		}
		return false;
	}
}
