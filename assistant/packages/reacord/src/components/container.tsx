import type { ReactNode } from "react";
import { ReacordElement } from "../internal/element";
import type {
	ContainerChildComponent,
	ContainerComponent,
	MessageOptions,
} from "../internal/message";
import { Node } from "../internal/node";
import { TextNode } from "../internal/text-node";

export interface ContainerProps {
	accentColor?: number;
	spoiler?: boolean;
	children?: ReactNode;
}

export function Container(props: ContainerProps) {
	return (
		<ReacordElement props={props} createNode={(p) => new ContainerNode(p)}>
			{props.children}
		</ReacordElement>
	);
}

export class ContainerNode extends Node<ContainerProps> {
	override get text() {
		return "";
	}

	protected override modifyMessageOptionsInternal(
		options: MessageOptions,
	): void {
		const childComponents: ContainerChildComponent[] = [];

		for (const child of this.children) {
			if (child instanceof TextNode) {
				const text = child.props;
				if (text.trim()) {
					childComponents.push({
						type: "textDisplay",
						content: text,
					});
				}
			} else {
				const childOptions: MessageOptions = { components: [] };
				child.modifyMessageOptions(childOptions);
				for (const component of childOptions.components) {
					if (
						component.type === "textDisplay" ||
						component.type === "section" ||
						component.type === "separator" ||
						component.type === "mediaGallery" ||
						component.type === "file" ||
						component.type === "actionRow"
					) {
						childComponents.push(component);
					}
				}
			}
		}

		const container: ContainerComponent = {
			type: "container",
			accentColor: this.props.accentColor,
			spoiler: this.props.spoiler,
			components: childComponents,
		};

		options.components.push(container);
	}
}
