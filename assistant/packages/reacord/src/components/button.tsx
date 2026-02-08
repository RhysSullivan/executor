import type { ButtonInteraction } from "discord.js";
import { createComponent } from "../create-component";

export interface ButtonProps {
	style?: "primary" | "secondary" | "success" | "danger";
	label?: string;
	emoji?: string;
	disabled?: boolean;
	onClick: (interaction: ButtonInteraction) => void | Promise<void>;
}

export const Button = createComponent<ButtonProps>({
	output: (props, { id }) => ({
		type: "actionRowItem",
		data: {
			type: "button",
			customId: id,
			style: props.style ?? "secondary",
			label: props.label,
			emoji: props.emoji,
			disabled: props.disabled,
		},
	}),

	onButton: (props, interaction) => {
		Promise.resolve(props.onClick(interaction.interaction));
	},
});
