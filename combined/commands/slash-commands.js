/* eslint-disable sort-imports */
import { SlashCommandBuilder } from "discord.js";
import {
	handleSendHomeworkInteraction,
	sendHomeworkCommand,
} from "./send-homework.js";
import { mockHomeworkCommand, handleMockHomework } from "./mock-homework.js";

const commandBuilders = [
	new SlashCommandBuilder()
		.setName("ping")
		.setDescription("Replies with Pong!"),
	sendHomeworkCommand,
	mockHomeworkCommand,
];

export const commands = commandBuilders.map((c) => c.toJSON());

// Unused example
const handlers = {
	async ping(interaction) {
		await interaction.reply({ content: "Pong!", ephemeral: true });
	},
	testhomework: handleMockHomework,
};

export async function handleSlashInteraction(interaction) {
	try {
		if (interaction.isChatInputCommand?.()) {
			const name = interaction.commandName;
			const handler = handlers[name];
			if (handler) {
				await handler(interaction);
				return;
			}

			// No explicit handler (e.g., sendhomework) → delegate to homework flow
			await handleSendHomeworkInteraction(interaction);
			return;
		}

		// Non-chat interactions (modal submit, buttons, selects) → pass to homework flow
		await handleSendHomeworkInteraction(interaction);
	} catch (error) {
		const message = "There was an error handling your interaction.";
		try {
			await (interaction.deferred || interaction.replied
				? interaction.followUp({ content: message, ephemeral: true })
				: interaction.reply({ content: message, ephemeral: true }));
		} catch {}

		const type = interaction?.type ?? "unknown";
		const name = interaction?.commandName ?? "(no-command)";
		console.error(`[interaction] type=${type} name=${name} failed:`, error);
	}
}

export function addCommand(builder, handler) {
	commandBuilders.push(builder);
	commands.push(builder.toJSON());
	handlers[builder.name] = handler;
}
