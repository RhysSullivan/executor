import { ReacordElement } from "../internal/element";
import type { ActionRowComponent, MessageOptions } from "../internal/message";
import { Node } from "../internal/node";

export interface ActionRowProps {
	children?: React.ReactNode;
}

export function ActionRow(props: ActionRowProps) {
	return (
		<ReacordElement props={props} createNode={(p) => new ActionRowNode(p)}>
			{props.children}
		</ReacordElement>
	);
}

class ActionRowNode extends Node<ActionRowProps> {
	override get text() {
		return "";
	}

	protected override modifyMessageOptionsInternal(
		options: MessageOptions,
	): void {
		const actionRow: ActionRowComponent = {
			type: "actionRow",
			components: [],
		};
		options.components.push(actionRow);

		const actionRowOptions: MessageOptions = {
			components: options.components,
			files: options.files,
			currentActionRow: actionRow,
		};

		for (const child of this.children) {
			child.modifyMessageOptions(actionRowOptions);
		}
	}
}
