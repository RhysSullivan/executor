import { randomUUID } from "node:crypto";
import type { ButtonInteraction } from "discord.js";
import type { ReactNode } from "react";
import { ReacordElement } from "../internal/element";
import type { ComponentInteraction } from "../internal/interaction";
import type {
	MessageOptions,
	SectionButtonComponent,
	SectionComponent,
	TextDisplayComponent,
	ThumbnailComponent,
} from "../internal/message";
import { Node } from "../internal/node";
import { TextNode } from "../internal/text-node";

export type SectionThumbnailAccessory = {
	type: "thumbnail";
	url: string;
	description?: string;
	spoiler?: boolean;
};

export type SectionButtonAccessory = {
	type: "button";
	label?: string;
	emoji?: string;
	style?: "primary" | "secondary" | "success" | "danger";
	disabled?: boolean;
	onClick?: (interaction: ButtonInteraction) => void | Promise<void>;
};

export type SectionLinkAccessory = {
	type: "link";
	url: string;
	label?: string;
	emoji?: string;
	disabled?: boolean;
};

export type SectionAccessory =
	| SectionThumbnailAccessory
	| SectionButtonAccessory
	| SectionLinkAccessory;

export interface SectionProps {
	accessory?: SectionAccessory;
	children?: ReactNode;
}

export function Section(props: SectionProps) {
	return (
		<ReacordElement props={props} createNode={(p) => new SectionNode(p)}>
			{props.children}
		</ReacordElement>
	);
}

class SectionNode extends Node<SectionProps> {
	private buttonCustomId = randomUUID();

	override get text() {
		return "";
	}

	protected override modifyMessageOptionsInternal(
		options: MessageOptions,
	): void {
		const textComponents: TextDisplayComponent[] = [];

		for (const child of this.children) {
			if (child instanceof TextNode) {
				const text = child.props;
				if (text.trim()) {
					textComponents.push({
						type: "textDisplay",
						content: text,
					});
				}
			} else {
				const childOptions: MessageOptions = { components: [] };
				child.modifyMessageOptions(childOptions);
				for (const component of childOptions.components) {
					if (component.type === "textDisplay") {
						textComponents.push(component);
					}
				}
			}
		}

		let accessory: ThumbnailComponent | SectionButtonComponent | undefined;

		if (this.props.accessory) {
			const acc = this.props.accessory;
			if (acc.type === "thumbnail") {
				accessory = {
					type: "thumbnail",
					url: acc.url,
					description: acc.description,
					spoiler: acc.spoiler,
				};
			} else if (acc.type === "button") {
				accessory = {
					type: "button",
					customId: this.buttonCustomId,
					style: acc.style ?? "secondary",
					label: acc.label,
					emoji: acc.emoji,
					disabled: acc.disabled,
				};
			} else if (acc.type === "link") {
				accessory = {
					type: "button",
					url: acc.url,
					style: "link",
					label: acc.label,
					emoji: acc.emoji,
					disabled: acc.disabled,
				};
			}
		}

		const section: SectionComponent = {
			type: "section",
			components: textComponents,
			accessory,
		};

		options.components.push(section);
	}

	override handleComponentInteraction(interaction: ComponentInteraction) {
		if (
			interaction.type === "button" &&
			interaction.customId === this.buttonCustomId &&
			this.props.accessory?.type === "button" &&
			this.props.accessory.onClick
		) {
			Promise.resolve(this.props.accessory.onClick(interaction.interaction));
			return true;
		}
		return false;
	}
}
