import { ReacordElement } from "../internal/element";
import type { MessageOptions, TextDisplayComponent } from "../internal/message";
import { Node } from "../internal/node";

export interface LoadingProps {
	message?: string;
}

interface LoadingNodeProps {
	message: string;
}

export function Loading({ message = "Loading..." }: LoadingProps) {
	return (
		<ReacordElement
			props={{ message }}
			createNode={(p) => new LoadingNode(p)}
		/>
	);
}

class LoadingNode extends Node<LoadingNodeProps> {
	protected override modifyMessageOptionsInternal(
		options: MessageOptions,
	): void {
		const textDisplay: TextDisplayComponent = {
			type: "textDisplay",
			content: this.props.message,
		};
		options.components.push(textDisplay);
	}
}
