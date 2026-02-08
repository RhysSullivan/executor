import type { UserSelectMenuInteraction } from "discord.js";
import { createComponent } from "../create-component";

export interface UserSelectProps {
	placeholder?: string;
	disabled?: boolean;
	minValues?: number;
	maxValues?: number;
	defaultUserIds?: string[];
	onSelect?: (
		userId: string,
		interaction: UserSelectMenuInteraction,
	) => void | Promise<void>;
	onSelectMultiple?: (
		userIds: string[],
		interaction: UserSelectMenuInteraction,
	) => void | Promise<void>;
}

export const UserSelect = createComponent<UserSelectProps>({
	output: (props, { id }) => ({
		type: "actionRowItem",
		data: {
			type: "userSelect",
			customId: id,
			placeholder: props.placeholder,
			disabled: props.disabled,
			minValues: props.minValues,
			maxValues: props.maxValues,
			defaultUserIds: props.defaultUserIds,
		},
	}),

	onUserSelect: (props, interaction) => {
		const selectedUserId = interaction.userIds[0];
		if (props.onSelectMultiple) {
			Promise.resolve(
				props.onSelectMultiple(interaction.userIds, interaction.interaction),
			);
		} else if (props.onSelect && selectedUserId) {
			Promise.resolve(props.onSelect(selectedUserId, interaction.interaction));
		}
	},
});
