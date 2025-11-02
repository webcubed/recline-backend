/* eslint-disable sort-imports */
import { SlashCommandBuilder } from "discord.js";
import {
	handleSendHomeworkInteraction,
	sendHomeworkCommand,
} from "./send-homework.js";

const commandBuilders = [
	new SlashCommandBuilder()
		.setName("ping")
		.setDescription("Replies with Pong!"),
	sendHomeworkCommand,
];

export const commands = commandBuilders.map((c) => c.toJSON());

// Unused example
const handlers = {
	async ping(interaction) {
		await interaction.reply({ content: "Pong!", ephemeral: true });
	},
};

export async function handleSlashInteraction(interaction) {
	if (!interaction.isChatInputCommand?.()) return;
	const name = interaction.commandName;
	const handler = handlers[name];
	if (!handler) {
		await handleSendHomeworkInteraction(interaction);
		return;
	}

	try {
		await handler(interaction);
	} catch (error) {
		const message = "There was an error while executing this command.";

		try {
			await (interaction.deferred || interaction.replied
				? interaction.followUp({ content: message, ephemeral: true })
				: interaction.reply({ content: message, ephemeral: true }));
		} catch {}

		console.error(`[slash] ${name} failed:`, error);
	}
}

export function addCommand(builder, handler) {
	commandBuilders.push(builder);
	commands.push(builder.toJSON());
	handlers[builder.name] = handler;
}
