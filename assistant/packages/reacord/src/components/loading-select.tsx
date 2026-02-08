import { ReacordElement } from "../internal/element";
import type {
	ActionRowComponent,
	MessageOptions,
	MessageSelectOptions,
} from "../internal/message";
import { Node } from "../internal/node";

export interface LoadingSelectProps {
	placeholder?: string;
}

interface LoadingSelectNodeProps {
	placeholder: string;
}

export function LoadingSelect({
	placeholder = "Loading...",
}: LoadingSelectProps) {
	return (
		<ReacordElement
			props={{ placeholder }}
			createNode={(p) => new LoadingSelectNode(p)}
		/>
	);
}

class LoadingSelectNode extends Node<LoadingSelectNodeProps> {
	override get text() {
		return "";
	}

	protected override modifyMessageOptionsInternal(
		options: MessageOptions,
	): void {
		const selectOptions: MessageSelectOptions = {
			type: "select",
			customId: "loading-select",
			placeholder: this.props.placeholder,
			disabled: true,
			options: [
				{
					value: "__loading__",
					label: this.props.placeholder,
				},
			],
		};

		const actionRow: ActionRowComponent = {
			type: "actionRow",
			components: [selectOptions],
		};
		options.components.push(actionRow);
	}
}
