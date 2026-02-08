import { Container } from "./container";
import type { ComponentInteraction } from "./interaction";
import type { MessageOptions } from "./message";

export abstract class Node<Props> {
	readonly children = new Container<Node<unknown>>();
	hidden = false;

	constructor(public props: Props) {}

	get text(): string {
		if (this.hidden) return "";
		return this.children.map((child) => child.text).join("");
	}

	modifyMessageOptions(options: MessageOptions): void {
		if (this.hidden) return;
		this.modifyMessageOptionsInternal(options);
	}

	protected modifyMessageOptionsInternal(_options: MessageOptions): void {}

	handleComponentInteraction(_interaction: ComponentInteraction): boolean {
		if (this.hidden) return false;
		for (const child of this.children) {
			if (child.handleComponentInteraction(_interaction)) {
				return true;
			}
		}
		return false;
	}
}
