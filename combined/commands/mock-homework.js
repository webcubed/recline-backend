import {
	ChannelType,
	PermissionsBitField,
	SlashCommandBuilder,
} from "discord.js";
import { renderEmbed, renderImage, renderText } from "./homework-renderers.js";

export const mockHomeworkCommand = new SlashCommandBuilder()
	.setName("testhomework")
	.setDescription("Post mock homework data (image/embed/text)")
	.addStringOption((opt) =>
		opt
			.setName("format")
			.setDescription("How to present the homework")
			.setRequired(true)
			.addChoices(
				{ name: "Image", value: "image" },
				{ name: "Embed", value: "embed" },
				{ name: "Text", value: "text" }
			)
	)
	.addChannelOption((opt) =>
		opt
			.setName("target")
			.setDescription("Channel to post into (defaults to current)")
			.addChannelTypes(ChannelType.GuildText)
	);

function buildMockEvents() {
	const now = Date.now();
	return [
		{
			title: "Read Chapter 5",
			classKey: "chan 9/10",
			dueTimestamp: now + 36 * 3600 * 1000,
		},
		{
			title: "Worksheet #3",
			classKey: "chan 9/10",
			dueTimestamp: now + 72 * 3600 * 1000,
		},
		{
			title: "Essay draft",
			classKey: "hua 5/6",
			dueTimestamp: now + 96 * 3600 * 1000,
		},
	];
}

async function buildPayload(format, events, headerClass) {
	if (format === "text")
		return { content: renderText({ events, headerClass }) };
	if (format === "embed") return renderEmbed({ events, headerClass });
	return renderImage({ events, headerClass });
}

export async function handleMockHomework(interaction) {
	const format = interaction.options.getString("format");
	const target =
		interaction.options.getChannel("target") ?? interaction.channel;

	// Permission check: user must be allowed to send messages in target
	const canUserSend = target
		.permissionsFor(interaction.member)
		?.has(PermissionsBitField.Flags.SendMessages);
	if (!canUserSend) {
		await interaction.reply({
			content: `You don't have permission to send messages in <#${target.id}>.`,
			ephemeral: true,
		});
		return;
	}

	await interaction.deferReply({ ephemeral: true });

	const events = buildMockEvents();
	const headerClass = "chan 9/10";
	const payload = await buildPayload(format, events, headerClass);
	let sent;
	try {
		sent = await target.send(payload);
	} catch (error) {
		await interaction.editReply({
			content: `Failed to post in <#${target.id}>: ${error.message ?? "unknown error"}`,
		});
		return;
	}

	await interaction.editReply({
		content: `Posted mock homework (${format}). Jump: https://discord.com/channels/${sent.guildId}/${sent.channelId}/${sent.id}`,
	});
}
