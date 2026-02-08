import { ReacordElement } from "../internal/element";
import { Node } from "../internal/node";

export interface OptionProps {
	value: string;
	label?: string;
	description?: string;
	emoji?: string;
}

export function Option(props: OptionProps) {
	return (
		<ReacordElement props={props} createNode={(p) => new OptionNode(p)}>
			<ReacordElement props={{}} createNode={() => new OptionLabelNode({})}>
				{props.label}
			</ReacordElement>
		</ReacordElement>
	);
}

export class OptionNode extends Node<OptionProps> {
	override get text() {
		return "";
	}

	getOptionData() {
		return {
			value: this.props.value,
			label: this.children.findType(OptionLabelNode)?.text ?? this.props.value,
			description: this.props.description,
			emoji: this.props.emoji,
		};
	}
}

class OptionLabelNode extends Node<Record<string, never>> {}
