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
	.addStringOption((opt) =>
		opt
			.setName("precision")
			.setDescription("Time precision for mock events")
			.setRequired(false)
			.addChoices(
				{ name: "Hour", value: "hour" },
				{ name: "Minute", value: "minute" },
				{ name: "Second", value: "second" },
				{ name: "All (post 3 messages)", value: "all" }
			)
	)
	.addChannelOption((opt) =>
		opt
			.setName("target")
			.setDescription("Channel to post into (defaults to current)")
			.addChannelTypes(ChannelType.GuildText)
			.setRequired(false)
	);

function atTopOfNextHour(offsetHours = 1) {
	const d = new Date();
	d.setMinutes(0, 0, 0);
	d.setHours(d.getHours() + offsetHours);
	return d.getTime();
}

function atNextMinuteWithZeroSeconds(offsetMinutes = 2) {
	const d = new Date();
	d.setSeconds(0, 0);
	d.setMinutes(d.getMinutes() + offsetMinutes);
	return d.getTime();
}

function atNextSecond(offsetSeconds = 15) {
	const d = new Date();
	d.setMilliseconds(0);
	d.setSeconds(d.getSeconds() + offsetSeconds);
	return d.getTime();
}

function buildMockEventsWithPrecision(precision) {
	if (precision === "hour") {
		return [
			{
				title: "Hour: Algebra",
				classKey: "chan 9/10",
				dueTimestamp: atTopOfNextHour(1),
			},
			{
				title: "Hour: Geometry",
				classKey: "chan 9/10",
				dueTimestamp: atTopOfNextHour(2),
			},
			{
				title: "Hour: English",
				classKey: "hua 5/6",
				dueTimestamp: atTopOfNextHour(3),
			},
		];
	}

	if (precision === "minute") {
		return [
			{
				title: "Minute: Reading",
				classKey: "chan 9/10",
				dueTimestamp: atNextMinuteWithZeroSeconds(2),
			},
			{
				title: "Minute: Writing",
				classKey: "chan 9/10",
				dueTimestamp: atNextMinuteWithZeroSeconds(5),
			},
			{
				title: "Minute: Science",
				classKey: "hua 5/6",
				dueTimestamp: atNextMinuteWithZeroSeconds(8),
			},
		];
	}

	if (precision === "second") {
		return [
			{
				title: "Second: Pop Quiz",
				classKey: "chan 9/10",
				dueTimestamp: atNextSecond(15),
			},
			{
				title: "Second: Quick Task",
				classKey: "chan 9/10",
				dueTimestamp: atNextSecond(30),
			},
			{
				title: "Second: Bell",
				classKey: "hua 5/6",
				dueTimestamp: atNextSecond(45),
			},
		];
	}

	// Default/fallback
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
	const precision = interaction.options.getString("precision") ?? "hour";
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

	const headerClass = "chan 9/10";

	const postOne = async (prec) => {
		const events = buildMockEventsWithPrecision(prec);
		const payload = await buildPayload(format, events, headerClass);
		const message = await target.send(payload);
		return `• ${prec}: https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
	};

	try {
		let summary;
		if (precision === "all") {
			const links = [];
			links.push(
				await postOne("hour"),
				await postOne("minute"),
				await postOne("second")
			);
			summary = `Posted mock homework (${format}) for hour/minute/second:\n${links.join("\n")}`;
		} else {
			const link = await postOne(precision);
			summary = `Posted mock homework (${format}) for ${precision}:\n${link}`;
		}

		await interaction.editReply({ content: summary });
	} catch (error) {
		await interaction.editReply({
			content: `Failed to post in <#${target.id}>: ${error.message ?? "unknown error"}`,
		});
	}
}
