import { RegistryProvider } from "@effect-atom/atom-react";
import type {
	ButtonInteraction,
	Client,
	CommandInteraction,
	Interaction,
	ModalSubmitInteraction,
	SendableChannels,
	StringSelectMenuInteraction,
	UserSelectMenuInteraction,
} from "discord.js";
import { Context, Effect, Layer, Runtime } from "effect";
import type { ReactNode } from "react";
import type { ReacordInstance } from "./instance";
import { InstanceProvider } from "./instance-context";
import { DiscordApiError } from "./internal/errors";
import { reconciler } from "./internal/reconciler";
import {
	createInteractionReplyRenderer,
	createMessageRenderer,
	type DiscordMessageOptions,
	type Renderer,
} from "./internal/renderer";

export type RunEffect = <A, E>(
	effect: Effect.Effect<A, E, never>,
) => Promise<A>;

const defaultRunEffect: RunEffect = <A, E>(
	effect: Effect.Effect<A, E, never>,
) => Runtime.runPromise(Runtime.defaultRuntime)(effect);

export interface ReacordConfig {
	maxInstances?: number;
}

export type SendOptions = {
	reply?: { messageReference: string };
};

export class Reacord extends Context.Tag("Reacord")<
	Reacord,
	{
		reply: (
			interaction: CommandInteraction,
			content: ReactNode,
		) => Effect.Effect<ReacordInstance>;
		send: (
			channel: SendableChannels,
			content: ReactNode,
			options?: SendOptions,
		) => Effect.Effect<ReacordInstance>;
		cleanup: () => void;
	}
>() {}

function isButtonInteraction(
	interaction: Interaction,
): interaction is ButtonInteraction {
	return interaction.isButton();
}

function isStringSelectMenuInteraction(
	interaction: Interaction,
): interaction is StringSelectMenuInteraction {
	return interaction.isStringSelectMenu();
}

function isModalSubmitInteraction(
	interaction: Interaction,
): interaction is ModalSubmitInteraction {
	return interaction.isModalSubmit();
}

function isUserSelectMenuInteraction(
	interaction: Interaction,
): interaction is UserSelectMenuInteraction {
	return interaction.isUserSelectMenu();
}

export function makeReacord(
	client: Client,
	config: ReacordConfig = {},
	runEffect: RunEffect = defaultRunEffect,
) {
	const renderers: Renderer[] = [];
	const maxInstances = config.maxInstances ?? 50;

	function onInteractionCreate(interaction: Interaction) {
		if (isButtonInteraction(interaction)) {
			runEffect(
				handleComponentInteraction(interaction).pipe(
					Effect.withSpan("reacord.handle_button_interaction", {
						attributes: {
							"reacord.interaction_type": "button",
							"reacord.custom_id": interaction.customId,
							"reacord.renderer_count": renderers.length,
						},
					}),
				),
			);
		} else if (isStringSelectMenuInteraction(interaction)) {
			runEffect(
				handleComponentInteraction(interaction).pipe(
					Effect.withSpan("reacord.handle_select_interaction", {
						attributes: {
							"reacord.interaction_type": "select",
							"reacord.custom_id": interaction.customId,
							"reacord.selected_values": interaction.values.join(","),
							"reacord.renderer_count": renderers.length,
						},
					}),
				),
			);
		} else if (isUserSelectMenuInteraction(interaction)) {
			runEffect(
				handleComponentInteraction(interaction).pipe(
					Effect.withSpan("reacord.handle_user_select_interaction", {
						attributes: {
							"reacord.interaction_type": "userSelect",
							"reacord.custom_id": interaction.customId,
							"reacord.selected_user_ids": interaction.values.join(","),
							"reacord.renderer_count": renderers.length,
						},
					}),
				),
			);
		} else if (isModalSubmitInteraction(interaction)) {
			runEffect(
				handleModalInteraction(interaction).pipe(
					Effect.withSpan("reacord.handle_modal_interaction", {
						attributes: {
							"reacord.interaction_type": "modal",
							"reacord.custom_id": interaction.customId,
							"reacord.renderer_count": renderers.length,
						},
					}),
				),
			);
		}
	}

	client.on("interactionCreate", onInteractionCreate);

	function handleComponentInteraction(
		interaction:
			| ButtonInteraction
			| StringSelectMenuInteraction
			| UserSelectMenuInteraction,
	): Effect.Effect<void> {
		return Effect.sync(() => {
			for (const renderer of renderers) {
				if (renderer.handleComponentInteraction(interaction)) {
					return;
				}
			}
		});
	}

	function handleModalInteraction(
		interaction: ModalSubmitInteraction,
	): Effect.Effect<void> {
		return Effect.sync(() => {
			for (const renderer of renderers) {
				if (renderer.handleModalInteraction(interaction)) {
					return;
				}
			}
		});
	}

	function createInstance(
		renderer: Renderer,
		initialContent?: ReactNode,
	): ReacordInstance {
		if (renderers.length >= maxInstances && renderers[0]) {
			deactivate(renderers[0]);
		}

		renderers.push(renderer);

		const container: unknown = reconciler.createContainer(
			renderer,
			0, // tag: ConcurrentRoot = 0, LegacyRoot = 1
			null, // hydrationCallbacks
			false, // isStrictMode
			null, // concurrentUpdatesByDefaultOverride
			"reacord", // identifierPrefix
			(error: Error) => console.error("[Reacord] recoverable error:", error), // onRecoverableError
			null, // transitionCallbacks
		);

		const instance: ReacordInstance = {
			render: (content: ReactNode) => {
				reconciler.updateContainer(
					<RegistryProvider>
						<InstanceProvider value={instance}>{content}</InstanceProvider>
					</RegistryProvider>,
					container,
				);
				return instance;
			},
			deactivate: () => {
				deactivate(renderer);
			},
			destroy: () => {
				const index = renderers.indexOf(renderer);
				if (index !== -1) {
					renderers.splice(index, 1);
				}
				renderer.destroy();
			},
		};

		if (initialContent !== undefined) {
			instance.render(initialContent);
		}

		return instance;
	}

	function deactivate(renderer: Renderer) {
		const index = renderers.indexOf(renderer);
		if (index !== -1) {
			renderers.splice(index, 1);
		}
		renderer.deactivate();
	}

	return {
		reply: (interaction: CommandInteraction, content: ReactNode) =>
			Effect.sync(() => {
				const renderer = createInteractionReplyRenderer(interaction, runEffect);
				return createInstance(renderer, content);
			}),
		send: (
			channel: SendableChannels,
			content: ReactNode,
			sendOptions?: SendOptions,
		) =>
			Effect.sync(() => {
				const renderer = createMessageRenderer(
					(options: DiscordMessageOptions) =>
						Effect.tryPromise({
							try: async () => {
								const message = await channel.send({
									...options,
									...(sendOptions?.reply ? { reply: sendOptions.reply } : {}),
								});
								return message;
							},
							catch: (cause) =>
								new DiscordApiError({ operation: "send", cause }),
						}),
					runEffect,
				);
				return createInstance(renderer, content);
			}),
		cleanup: () => {
			client.off("interactionCreate", onInteractionCreate);
			for (const renderer of renderers) {
				renderer.deactivate();
			}
			renderers.length = 0;
		},
	};
}

export function ReacordLive(client: Client, config: ReacordConfig = {}) {
	return Layer.effect(
		Reacord,
		Effect.gen(function* () {
			const runtime = yield* Effect.runtime<never>();
			const runEffect: RunEffect = (eff) => Runtime.runPromise(runtime)(eff);
			return makeReacord(client, config, runEffect);
		}),
	);
}
