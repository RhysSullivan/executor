import { Node } from "./node";

export class TextNode extends Node<string> {
	override get text() {
		if (this.hidden) return "";
		return this.props;
	}
}
