import {
	type ButtonInteraction,
	ButtonStyle,
	type CommandInteraction,
	ComponentType,
	type Message,
	MessageFlags,
	type ModalSubmitInteraction,
	SeparatorSpacingSize,
	type StringSelectMenuInteraction,
	type UserSelectMenuInteraction,
} from "discord.js";
import { Effect, Runtime } from "effect";
import { Container } from "./container";
import { DiscordApiError } from "./errors";
import type { ComponentInteraction } from "./interaction";
import type {
	ActionRowComponent,
	ActionRowItemOptions,
	ContainerChildComponent,
	ContainerComponent,
	FileComponentData,
	MediaGalleryComponent,
	MessageButtonOptions,
	MessageOptions,
	MessageSelectOptions,
	SectionComponent,
	SeparatorComponent,
	TextDisplayComponent,
	ThumbnailComponent,
	V2Component,
} from "./message";
import type { Node } from "./node";

type RunEffect = <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;

const defaultRunEffect: RunEffect = <A, E>(
	effect: Effect.Effect<A, E, never>,
) => Runtime.runPromise(Runtime.defaultRuntime)(effect);

let rendererId = 0;

const DEFER_UPDATE_DELAY_MS = 500;

type DiscordV2Component =
	| {
			type: ComponentType.TextDisplay;
			content: string;
			id?: number;
	  }
	| {
			type: ComponentType.Container;
			accent_color?: number;
			spoiler?: boolean;
			components: DiscordContainerChild[];
	  }
	| {
			type: ComponentType.Section;
			components: Array<{ type: ComponentType.TextDisplay; content: string }>;
			accessory?: DiscordThumbnail | DiscordButton;
	  }
	| {
			type: ComponentType.Separator;
			divider?: boolean;
			spacing?: SeparatorSpacingSize;
	  }
	| {
			type: ComponentType.MediaGallery;
			items: Array<{
				media: { url: string };
				description?: string;
				spoiler?: boolean;
			}>;
	  }
	| {
			type: ComponentType.File;
			file: { url: string };
			spoiler?: boolean;
	  }
	| DiscordActionRow;

type DiscordContainerChild =
	| { type: ComponentType.TextDisplay; content: string; id?: number }
	| {
			type: ComponentType.Section;
			components: Array<{ type: ComponentType.TextDisplay; content: string }>;
			accessory?: DiscordThumbnail | DiscordButton;
	  }
	| {
			type: ComponentType.Separator;
			divider?: boolean;
			spacing?: SeparatorSpacingSize;
	  }
	| {
			type: ComponentType.MediaGallery;
			items: Array<{
				media: { url: string };
				description?: string;
				spoiler?: boolean;
			}>;
	  }
	| { type: ComponentType.File; file: { url: string }; spoiler?: boolean }
	| DiscordActionRow;

type DiscordThumbnail = {
	type: ComponentType.Thumbnail;
	media: { url: string };
	description?: string;
	spoiler?: boolean;
};

type DiscordButton = {
	type: ComponentType.Button;
	custom_id?: string;
	url?: string;
	style: ButtonStyle;
	label?: string;
	emoji?: string;
	disabled?: boolean;
};

type DiscordActionRow = {
	type: ComponentType.ActionRow;
	components: Array<{
		type:
			| ComponentType.Button
			| ComponentType.StringSelect
			| ComponentType.UserSelect;
		custom_id?: string;
		url?: string;
		label?: string;
		style?: ButtonStyle;
		disabled?: boolean;
		emoji?: string;
		placeholder?: string;
		min_values?: number;
		max_values?: number;
		options?: Array<{
			label: string;
			value: string;
			description?: string;
			emoji?: string;
			default?: boolean;
		}>;
		default_values?: Array<{ id: string; type: "user" }>;
	}>;
};

export type DiscordMessageOptions = {
	flags: number;
	components: DiscordV2Component[];
	files?: Array<{
		attachment: string | Buffer;
		name: string;
		spoiler?: boolean;
	}>;
};

type RendererOptions =
	| {
			type: "interaction";
			interaction: CommandInteraction;
			runEffect?: RunEffect;
	  }
	| {
			type: "message";
			createMessage: (
				options: DiscordMessageOptions,
			) => Effect.Effect<Message, DiscordApiError>;
			runEffect?: RunEffect;
	  };

export class Renderer {
	readonly nodes = new Container<Node<unknown>>();
	private componentInteraction?: ComponentInteraction;
	private message?: Message;
	private active = true;
	private updateQueue: Array<() => Effect.Effect<void, DiscordApiError>> = [];
	private processing = false;
	private readonly id = ++rendererId;
	private pendingRender = false;
	private lastMessageOptionsHash: string | null = null;

	constructor(private readonly options: RendererOptions) {}

	render() {
		if (!this.active) {
			return;
		}

		if (this.pendingRender) {
			return;
		}
		this.pendingRender = true;
		this.enqueue(() => {
			this.pendingRender = false;
			return this.doUpdateIfChanged();
		});
	}

	private doUpdateIfChanged(): Effect.Effect<void, DiscordApiError> {
		const options = this.getMessageOptions();
		const hash = this.hashMessageOptions(options);

		if (hash === this.lastMessageOptionsHash && !this.componentInteraction) {
			return Effect.void;
		}

		this.lastMessageOptionsHash = hash;
		return this.doUpdate();
	}

	private hashMessageOptions(options: MessageOptions): string {
		return JSON.stringify({
			components: options.components,
			files: options.files,
		});
	}

	deactivate() {
		this.active = false;
		this.enqueue(() => this.doDeactivate());
	}

	destroy() {
		this.active = false;
		this.enqueue(() => this.doDestroy());
	}

	handleComponentInteraction(
		interaction:
			| ButtonInteraction
			| StringSelectMenuInteraction
			| UserSelectMenuInteraction,
	): boolean {
		const reacordInteraction = this.toReacordInteraction(interaction);

		for (const node of this.nodes) {
			this.componentInteraction = reacordInteraction;

			try {
				if (node.handleComponentInteraction(reacordInteraction)) {
					setTimeout(() => {
						this.enqueue(() => this.doDeferUpdate(interaction));
					}, DEFER_UPDATE_DELAY_MS);
					return true;
				}
			} finally {
				this.componentInteraction = undefined;
			}
		}
		return false;
	}

	handleModalInteraction(interaction: ModalSubmitInteraction): boolean {
		const fields = new Map<string, string>();
		for (const [key, field] of interaction.fields.fields) {
			if ("value" in field && typeof field.value === "string") {
				fields.set(key, field.value);
			}
		}

		const reacordInteraction: ComponentInteraction = {
			type: "modal",
			customId: interaction.customId,
			fields,
			interaction,
		};

		for (const node of this.nodes) {
			this.componentInteraction = reacordInteraction;

			try {
				if (node.handleComponentInteraction(reacordInteraction)) {
					setTimeout(() => {
						this.enqueue(() => this.doDeferModalUpdate(interaction));
					}, DEFER_UPDATE_DELAY_MS);
					return true;
				}
			} finally {
				this.componentInteraction = undefined;
			}
		}
		return false;
	}

	private toReacordInteraction(
		interaction:
			| ButtonInteraction
			| StringSelectMenuInteraction
			| UserSelectMenuInteraction,
	): ComponentInteraction {
		if (interaction.isButton()) {
			return {
				type: "button",
				customId: interaction.customId,
				interaction,
			};
		}
		if (interaction.isUserSelectMenu()) {
			return {
				type: "userSelect",
				customId: interaction.customId,
				userIds: interaction.values,
				interaction,
			};
		}
		return {
			type: "select",
			customId: interaction.customId,
			values: interaction.values,
			interaction,
		};
	}

	private enqueue(task: () => Effect.Effect<void, DiscordApiError>) {
		this.updateQueue.push(task);
		this.processQueue();
	}

	private get runEffect(): RunEffect {
		return this.options.runEffect ?? defaultRunEffect;
	}

	private processQueue() {
		if (this.processing) return;
		this.processing = true;

		const processNext = () => {
			const task = this.updateQueue.shift();
			if (!task) {
				this.processing = false;
				return;
			}

			this.runEffect(
				task().pipe(
					Effect.catchAll((error) =>
						Effect.sync(() => {
							console.error("Reacord update error:", error);
						}),
					),
				),
			)
				.then(processNext)
				.catch((error) => {
					console.error("Reacord queue processing error:", error);
					processNext();
				});
		};

		processNext();
	}

	private getMessageOptions(): MessageOptions {
		const options: MessageOptions = {
			components: [],
		};
		for (const node of this.nodes) {
			node.modifyMessageOptions(options);
		}
		return options;
	}

	private toDiscordOptions(options: MessageOptions): DiscordMessageOptions {
		return {
			flags: MessageFlags.IsComponentsV2,
			components: options.components.map((c) => this.toDiscordComponent(c)),
			files: options.files?.map((f) => ({
				attachment: f.data ?? f.url ?? "",
				name: f.name,
				spoiler: f.spoiler,
			})),
		};
	}

	private toDiscordComponent(component: V2Component): DiscordV2Component {
		switch (component.type) {
			case "textDisplay":
				return this.toDiscordTextDisplay(component);
			case "container":
				return this.toDiscordContainer(component);
			case "section":
				return this.toDiscordSection(component);
			case "separator":
				return this.toDiscordSeparator(component);
			case "mediaGallery":
				return this.toDiscordMediaGallery(component);
			case "thumbnail":
				return this.toDiscordThumbnailTopLevel(component);
			case "file":
				return this.toDiscordFile(component);
			case "actionRow":
				return this.toDiscordActionRow(component);
		}
	}

	private toDiscordThumbnailTopLevel(component: ThumbnailComponent): {
		type: ComponentType.Section;
		components: Array<{ type: ComponentType.TextDisplay; content: string }>;
		accessory: DiscordThumbnail;
	} {
		return {
			type: ComponentType.Section,
			components: [],
			accessory: {
				type: ComponentType.Thumbnail,
				media: { url: component.url },
				description: component.description,
				spoiler: component.spoiler,
			},
		};
	}

	private toDiscordTextDisplay(component: TextDisplayComponent): {
		type: ComponentType.TextDisplay;
		content: string;
		id?: number;
	} {
		return {
			type: ComponentType.TextDisplay,
			content: component.content,
			id: component.id,
		};
	}

	private toDiscordContainer(component: ContainerComponent): {
		type: ComponentType.Container;
		accent_color?: number;
		spoiler?: boolean;
		components: DiscordContainerChild[];
	} {
		return {
			type: ComponentType.Container,
			accent_color: component.accentColor,
			spoiler: component.spoiler,
			components: component.components.map((c) =>
				this.toDiscordContainerChild(c),
			),
		};
	}

	private toDiscordContainerChild(
		component: ContainerChildComponent,
	): DiscordContainerChild {
		switch (component.type) {
			case "textDisplay":
				return this.toDiscordTextDisplay(component);
			case "section":
				return this.toDiscordSection(component);
			case "separator":
				return this.toDiscordSeparator(component);
			case "mediaGallery":
				return this.toDiscordMediaGallery(component);
			case "file":
				return this.toDiscordFile(component);
			case "actionRow":
				return this.toDiscordActionRow(component);
		}
	}

	private toDiscordSection(component: SectionComponent): {
		type: ComponentType.Section;
		components: Array<{ type: ComponentType.TextDisplay; content: string }>;
		accessory?: DiscordThumbnail | DiscordButton;
	} {
		return {
			type: ComponentType.Section,
			components: component.components.map((c) => ({
				type: ComponentType.TextDisplay,
				content: c.content,
			})),
			accessory: component.accessory
				? this.toDiscordAccessory(component.accessory)
				: undefined,
		};
	}

	private toDiscordAccessory(
		accessory:
			| ThumbnailComponent
			| {
					type: "button";
					customId?: string;
					url?: string;
					style: "primary" | "secondary" | "success" | "danger" | "link";
					label?: string;
					emoji?: string;
					disabled?: boolean;
			  },
	): DiscordThumbnail | DiscordButton {
		if (accessory.type === "thumbnail") {
			return {
				type: ComponentType.Thumbnail,
				media: { url: accessory.url },
				description: accessory.description,
				spoiler: accessory.spoiler,
			};
		}
		return {
			type: ComponentType.Button,
			custom_id: accessory.customId,
			url: accessory.url,
			style: this.convertButtonStyle(accessory.style),
			label: accessory.label,
			emoji: accessory.emoji,
			disabled: accessory.disabled,
		};
	}

	private toDiscordSeparator(component: SeparatorComponent): {
		type: ComponentType.Separator;
		divider?: boolean;
		spacing?: SeparatorSpacingSize;
	} {
		return {
			type: ComponentType.Separator,
			divider: component.divider,
			spacing: component.spacing
				? component.spacing === "small"
					? SeparatorSpacingSize.Small
					: SeparatorSpacingSize.Large
				: undefined,
		};
	}

	private toDiscordMediaGallery(component: MediaGalleryComponent): {
		type: ComponentType.MediaGallery;
		items: Array<{
			media: { url: string };
			description?: string;
			spoiler?: boolean;
		}>;
	} {
		return {
			type: ComponentType.MediaGallery,
			items: component.items.map((item) => ({
				media: { url: item.url },
				description: item.description,
				spoiler: item.spoiler,
			})),
		};
	}

	private toDiscordFile(component: FileComponentData): {
		type: ComponentType.File;
		file: { url: string };
		spoiler?: boolean;
	} {
		return {
			type: ComponentType.File,
			file: { url: component.url },
			spoiler: component.spoiler,
		};
	}

	private toDiscordActionRow(component: ActionRowComponent): DiscordActionRow {
		return {
			type: ComponentType.ActionRow,
			components: component.components.map((c) =>
				this.toDiscordActionRowItem(c),
			),
		};
	}

	private toDiscordActionRowItem(component: ActionRowItemOptions): {
		type:
			| ComponentType.Button
			| ComponentType.StringSelect
			| ComponentType.UserSelect;
		custom_id?: string;
		url?: string;
		label?: string;
		style?: ButtonStyle;
		disabled?: boolean;
		emoji?: string;
		placeholder?: string;
		min_values?: number;
		max_values?: number;
		options?: Array<{
			label: string;
			value: string;
			description?: string;
			emoji?: string;
			default?: boolean;
		}>;
		default_values?: Array<{ id: string; type: "user" }>;
	} {
		if (component.type === "button") {
			return {
				type: ComponentType.Button,
				custom_id: component.customId,
				label: component.label ?? "",
				style: this.convertButtonStyle(component.style),
				disabled: component.disabled,
				emoji: component.emoji,
			};
		}

		if (component.type === "link") {
			return {
				type: ComponentType.Button,
				url: component.url,
				label: component.label ?? "",
				style: ButtonStyle.Link,
				disabled: component.disabled,
				emoji: component.emoji,
			};
		}

		if (component.type === "userSelect") {
			return {
				type: ComponentType.UserSelect,
				custom_id: component.customId,
				placeholder: component.placeholder,
				disabled: component.disabled,
				min_values: component.minValues,
				max_values: component.maxValues,
				default_values: component.defaultUserIds?.map((id) => ({
					id,
					type: "user" as const,
				})),
			};
		}

		return {
			type: ComponentType.StringSelect,
			custom_id: component.customId,
			placeholder: component.placeholder,
			disabled: component.disabled,
			min_values: component.minValues,
			max_values: component.maxValues,
			options: component.options.map((opt) => ({
				...opt,
				default: component.values?.includes(opt.value),
			})),
		};
	}

	private convertButtonStyle(
		style: MessageButtonOptions["style"] | "link",
	): ButtonStyle {
		const styleMap = {
			primary: ButtonStyle.Primary,
			secondary: ButtonStyle.Secondary,
			success: ButtonStyle.Success,
			danger: ButtonStyle.Danger,
			link: ButtonStyle.Link,
		} as const;
		return styleMap[style ?? "secondary"];
	}

	private doUpdate(): Effect.Effect<void, DiscordApiError> {
		const hasComponentInteraction = !!this.componentInteraction;
		const componentInteractionType = this.componentInteraction?.type;
		const componentInteractionCustomId = this.componentInteraction?.customId;

		return Effect.gen(this, function* () {
			yield* Effect.annotateCurrentSpan({
				"reacord.renderer_id": this.id,
				"reacord.has_component_interaction": hasComponentInteraction,
				"reacord.component_interaction_type":
					componentInteractionType ?? "none",
				"reacord.component_interaction_custom_id":
					componentInteractionCustomId ?? "none",
				"reacord.options_type": this.options.type,
				"reacord.has_message": !!this.message,
				"reacord.active": this.active,
			});

			const options = this.getMessageOptions();
			const discordOptions = this.toDiscordOptions(options);

			const selectComponents = options.components
				.filter((c): c is ActionRowComponent => c.type === "actionRow")
				.flatMap((row) =>
					row.components.filter(
						(c): c is MessageSelectOptions => c.type === "select",
					),
				);

			const selectValues = selectComponents.map((s) => ({
				customId: s.customId,
				rawValues: s.values,
			}));

			const buttonComponents = options.components
				.filter((c): c is ActionRowComponent => c.type === "actionRow")
				.flatMap((row) =>
					row.components.filter(
						(c): c is MessageButtonOptions => c.type === "button",
					),
				);

			const buttonStates = buttonComponents.map((b) => ({
				label: b.label,
				disabled: b.disabled,
			}));

			yield* Effect.annotateCurrentSpan({
				"reacord.component_count": discordOptions.components?.length ?? 0,
				"reacord.select_values": JSON.stringify(selectValues),
				"reacord.button_states": JSON.stringify(buttonStates),
			});

			if (this.componentInteraction) {
				const componentInteraction = this.componentInteraction;
				this.componentInteraction = undefined;
				if (componentInteraction.type === "modal") {
					yield* Effect.annotateCurrentSpan({
						"reacord.update_path": "modal_skip",
					});
					return;
				}
				yield* Effect.annotateCurrentSpan({
					"reacord.update_path": "component_interaction_update",
				});
				yield* Effect.tryPromise({
					try: () => componentInteraction.interaction.update(discordOptions),
					catch: (cause) => new DiscordApiError({ operation: "update", cause }),
				}).pipe(Effect.withSpan("reacord.discord_update"));
				return;
			}

			if (this.options.type === "interaction") {
				const interaction = this.options.interaction;
				yield* Effect.annotateCurrentSpan({
					"reacord.interaction_deferred": interaction.deferred,
					"reacord.interaction_replied": interaction.replied,
				});
				if (interaction.deferred || interaction.replied) {
					yield* Effect.annotateCurrentSpan({
						"reacord.update_path": "edit_reply",
					});
					const message = yield* Effect.tryPromise({
						try: () => interaction.editReply(discordOptions),
						catch: (cause) =>
							new DiscordApiError({ operation: "editReply", cause }),
					}).pipe(Effect.withSpan("reacord.discord_edit_reply"));
					if (!this.message && message) {
						this.message = message;
					}
					return;
				}
				yield* Effect.annotateCurrentSpan({
					"reacord.update_path": "initial_reply",
				});
				this.message = yield* Effect.tryPromise({
					try: () => interaction.reply({ ...discordOptions, fetchReply: true }),
					catch: (cause) => new DiscordApiError({ operation: "reply", cause }),
				}).pipe(Effect.withSpan("reacord.discord_reply"));
				return;
			}

			const message = this.message;
			if (message) {
				yield* Effect.annotateCurrentSpan({
					"reacord.update_path": "message_edit",
				});
				yield* Effect.tryPromise({
					try: () => message.edit(discordOptions),
					catch: (cause) => new DiscordApiError({ operation: "edit", cause }),
				}).pipe(Effect.withSpan("reacord.discord_message_edit"));
				return;
			}

			yield* Effect.annotateCurrentSpan({
				"reacord.update_path": "create_message",
			});
			this.message = yield* this.options
				.createMessage(discordOptions)
				.pipe(Effect.withSpan("reacord.discord_create_message"));
		}).pipe(Effect.withSpan("reacord.do_update"));
	}

	private doDeactivate(): Effect.Effect<void, DiscordApiError> {
		const rendererOptions = this.options;
		const message = this.message;
		return Effect.gen(this, function* () {
			yield* Effect.annotateCurrentSpan({
				"reacord.renderer_id": this.id,
				"reacord.options_type": rendererOptions.type,
			});

			const options = this.getMessageOptions();
			const discordOptions = this.toDiscordOptions(options);

			discordOptions.components = this.disableAllComponents(
				discordOptions.components,
			);

			if (rendererOptions.type === "interaction") {
				yield* Effect.tryPromise({
					try: () => rendererOptions.interaction.editReply(discordOptions),
					catch: (cause) =>
						new DiscordApiError({ operation: "editReply", cause }),
				}).pipe(Effect.withSpan("reacord.discord_deactivate_edit_reply"));
				return;
			}

			if (message) {
				yield* Effect.tryPromise({
					try: () => message.edit(discordOptions),
					catch: (cause) => new DiscordApiError({ operation: "edit", cause }),
				}).pipe(Effect.withSpan("reacord.discord_deactivate_message_edit"));
			}
		}).pipe(Effect.withSpan("reacord.do_deactivate"));
	}

	private disableAllComponents(
		components: DiscordV2Component[],
	): DiscordV2Component[] {
		return components.map((c) => {
			if (c.type === ComponentType.ActionRow) {
				return {
					...c,
					components: c.components.map((item) => ({ ...item, disabled: true })),
				};
			}
			if (c.type === ComponentType.Container) {
				return {
					...c,
					components: this.disableContainerChildren(c.components),
				};
			}
			return c;
		});
	}

	private disableContainerChildren(
		components: DiscordContainerChild[],
	): DiscordContainerChild[] {
		return components.map((c) => {
			if (c.type === ComponentType.ActionRow) {
				return {
					...c,
					components: c.components.map((item) => ({ ...item, disabled: true })),
				};
			}
			if (c.type === ComponentType.Section && c.accessory) {
				if (c.accessory.type === ComponentType.Button) {
					return {
						...c,
						accessory: { ...c.accessory, disabled: true },
					};
				}
			}
			return c;
		});
	}

	private doDestroy(): Effect.Effect<void, DiscordApiError> {
		const rendererOptions = this.options;
		const message = this.message;
		return Effect.gen(function* () {
			if (rendererOptions.type === "interaction") {
				yield* Effect.tryPromise({
					try: () => rendererOptions.interaction.deleteReply(),
					catch: (cause) =>
						new DiscordApiError({ operation: "deleteReply", cause }),
				}).pipe(Effect.withSpan("reacord.discord_delete_reply"));
				return;
			}

			if (message) {
				yield* Effect.tryPromise({
					try: () => message.delete(),
					catch: (cause) => new DiscordApiError({ operation: "delete", cause }),
				}).pipe(Effect.withSpan("reacord.discord_delete_message"));
			}
		}).pipe(Effect.withSpan("reacord.do_destroy"));
	}

	private doDeferUpdate(
		interaction:
			| ButtonInteraction
			| StringSelectMenuInteraction
			| UserSelectMenuInteraction,
	): Effect.Effect<void, DiscordApiError> {
		return Effect.gen(function* () {
			yield* Effect.annotateCurrentSpan({
				"reacord.interaction_deferred": interaction.deferred,
				"reacord.interaction_replied": interaction.replied,
			});
			if (!interaction.deferred && !interaction.replied) {
				yield* Effect.tryPromise({
					try: () => interaction.deferUpdate(),
					catch: (cause) =>
						new DiscordApiError({ operation: "deferUpdate", cause }),
				}).pipe(Effect.withSpan("reacord.discord_defer_update"));
			}
		}).pipe(Effect.withSpan("reacord.do_defer_update"));
	}

	private doDeferModalUpdate(
		interaction: ModalSubmitInteraction,
	): Effect.Effect<void, DiscordApiError> {
		const rendererOptions = this.options;
		return Effect.gen(this, function* () {
			yield* Effect.annotateCurrentSpan({
				"reacord.interaction_deferred": interaction.deferred,
				"reacord.interaction_replied": interaction.replied,
			});
			if (!interaction.deferred && !interaction.replied) {
				yield* Effect.tryPromise({
					try: () => interaction.deferUpdate(),
					catch: (cause) =>
						new DiscordApiError({ operation: "deferUpdate", cause }),
				}).pipe(Effect.withSpan("reacord.discord_defer_modal_update"));

				const options = this.getMessageOptions();
				const discordOptions = this.toDiscordOptions(options);

				if (rendererOptions.type === "interaction") {
					yield* Effect.tryPromise({
						try: () => rendererOptions.interaction.editReply(discordOptions),
						catch: (cause) =>
							new DiscordApiError({ operation: "editReply", cause }),
					}).pipe(Effect.withSpan("reacord.discord_modal_edit_reply"));
				}
			}
		}).pipe(Effect.withSpan("reacord.do_defer_modal_update"));
	}
}

export function createInteractionReplyRenderer(
	interaction: CommandInteraction,
	runEffect?: RunEffect,
) {
	return new Renderer({
		type: "interaction",
		interaction,
		runEffect,
	});
}

export function createMessageRenderer(
	createMessage: (
		options: DiscordMessageOptions,
	) => Effect.Effect<Message, DiscordApiError>,
	runEffect?: RunEffect,
) {
	return new Renderer({
		type: "message",
		createMessage,
		runEffect,
	});
}
