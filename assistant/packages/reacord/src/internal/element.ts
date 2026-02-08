import React, { type ReactNode } from "react";
import type { Node } from "./node";

export function ReacordElement<Props>(props: {
	props: Props;
	createNode: (props: Props) => Node<Props>;
	children?: ReactNode;
}) {
	return React.createElement("reacord-element", props);
}
