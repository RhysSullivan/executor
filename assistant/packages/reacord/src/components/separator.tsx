import { createComponent } from "../create-component";

export interface SeparatorProps {
	divider?: boolean;
	spacing?: "small" | "large";
}

export const Separator = createComponent<SeparatorProps>({
	output: (props) => ({
		type: "component",
		data: {
			type: "separator",
			divider: props.divider ?? true,
			spacing: props.spacing,
		},
	}),
});
