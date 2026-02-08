import type { ReactNode } from "react";
import { createComponent } from "../create-component";

export interface TextDisplayProps {
	children?: ReactNode;
}

export const TextDisplay = createComponent<TextDisplayProps>({
	output: (_props, { text }) => ({
		type: "component",
		data: {
			type: "textDisplay",
			content: text,
		},
	}),
});
