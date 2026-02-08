import { createComponent } from "../create-component";

export interface LinkProps {
	url: string;
	label?: string;
	emoji?: string;
	disabled?: boolean;
}

export const Link = createComponent<LinkProps>({
	output: (props) => ({
		type: "actionRowItem",
		data: {
			type: "link",
			url: props.url,
			label: props.label,
			emoji: props.emoji,
			disabled: props.disabled,
		},
	}),
});
