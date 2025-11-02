import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	InteractionType,
	ModalBuilder,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { SCHEDULE_TYPES, getStartTimeForPeriod } from "./bell-schedule.js";
import { renderEmbed, renderImage, renderText } from "./homework-renderers.js";

export const sendHomeworkCommand = new SlashCommandBuilder()
	.setName("sendhomework")
	.setDescription("Collect and send homework as image/embed/text")
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

const sessions = new Map();

const CLASS_OPTIONS = [
	{ label: "chan 8/9", value: "chan 8/9" },
	{ label: "chan 9/10", value: "chan 9/10" },
	{ label: "hua 5/6", value: "hua 5/6" },
	{ label: "hua 7/8", value: "hua 7/8" },
	{ label: "maggio 2/3", value: "maggio 2/3" },
	{ label: "maggio 6/7", value: "maggio 6/7" },
];

const DAY_OPTIONS = [
	{ label: "A Day", value: "A" },
	{ label: "B Day", value: "B" },
];

const SCHEDULE_OPTIONS = [
	{ label: "Regular", value: SCHEDULE_TYPES.REGULAR },
	{ label: "Conference", value: SCHEDULE_TYPES.CONFERENCE },
];

const PERIOD_OPTIONS = Array.from({ length: 10 }, (_, i) => {
	const p = i + 1;
	return { label: `Period ${p}`, value: String(p) };
});

function buildModal() {
	const modal = new ModalBuilder()
		.setCustomId("hw_modal")
		.setTitle("Add homework");
	const title = new TextInputBuilder()
		.setCustomId("hw_title")
		.setLabel("Event/Assignment")
		.setStyle(TextInputStyle.Short)
		.setMaxLength(200)
		.setRequired(true);
	const due = new TextInputBuilder()
		.setCustomId("hw_due")
		.setLabel("Due date (e.g., November 7, 2025)")
		.setPlaceholder("November 7, 2025")
		.setStyle(TextInputStyle.Short)
		.setRequired(true);
	const time = new TextInputBuilder()
		.setCustomId("hw_time")
		.setLabel("Time override (HH:MM:SS, 24h, optional)")
		.setPlaceholder("08:00:00")
		.setStyle(TextInputStyle.Short)
		.setRequired(false);

	return modal.addComponents(
		new ActionRowBuilder().addComponents(title),
		new ActionRowBuilder().addComponents(due),
		new ActionRowBuilder().addComponents(time)
	);
}

function buildSelectionRows({
	classValue = "chan 9/10",
	dayValue = "A",
	periodValue = "10",
	scheduleValue = SCHEDULE_TYPES.REGULAR,
}) {
	const classSelect = new StringSelectMenuBuilder()
		.setCustomId("hw_class")
		.setPlaceholder("Select class")
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(CLASS_OPTIONS)
		.setDefaultValues?.([{ id: "hw_class", value: classValue }]);

	const daySelect = new StringSelectMenuBuilder()
		.setCustomId("hw_day")
		.setPlaceholder("A or B day")
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(DAY_OPTIONS);

	const periodSelect = new StringSelectMenuBuilder()
		.setCustomId("hw_period")
		.setPlaceholder("Period (default based on class/day)")
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(PERIOD_OPTIONS);

	const scheduleSelect = new StringSelectMenuBuilder()
		.setCustomId("hw_schedule")
		.setPlaceholder("Schedule type")
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(SCHEDULE_OPTIONS);

	return [
		new ActionRowBuilder().addComponents(
			classSelect.setPlaceholder(classValue)
		),
		new ActionRowBuilder().addComponents(daySelect.setPlaceholder(dayValue)),
		new ActionRowBuilder().addComponents(
			periodSelect.setPlaceholder(periodValue)
		),
		new ActionRowBuilder().addComponents(
			scheduleSelect.setPlaceholder(scheduleValue)
		),
	];
}

function buildConfirmRows() {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId("hw_save")
				.setStyle(ButtonStyle.Success)
				.setLabel("Save event"),
			new ButtonBuilder()
				.setCustomId("hw_cancel")
				.setStyle(ButtonStyle.Secondary)
				.setLabel("Cancel")
		),
	];
}

function buildNextRows() {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId("hw_add")
				.setStyle(ButtonStyle.Primary)
				.setLabel("Add another"),
			new ButtonBuilder()
				.setCustomId("hw_done")
				.setStyle(ButtonStyle.Success)
				.setLabel("Done")
		),
	];
}

export async function handleSendHomeworkInteraction(interaction) {
	if (shouldStart(interaction)) {
		await startSession(interaction);
		return;
	}

	if (
		interaction.type === InteractionType.ModalSubmit &&
		interaction.customId === "hw_modal"
	) {
		await handleModalSubmit(interaction);
		return;
	}

	if (
		interaction.isStringSelectMenu() &&
		interaction.customId.startsWith("hw_")
	) {
		await handleSelectUpdate(interaction);
		return;
	}

	// Handle buttons: save, add another, done, cancel
	if (interaction.isButton() && interaction.customId.startsWith("hw_")) {
		await handleButtonPress(interaction);
	}
}

async function handleModalSubmit(interaction) {
	const session = sessions.get(interaction.user.id);
	if (!session)
		return interaction.reply({
			content: "Session expired.",
			ephemeral: true,
		});

	const title = interaction.fields.getTextInputValue("hw_title");
	const due = interaction.fields.getTextInputValue("hw_due");
	const time = interaction.fields.getTextInputValue("hw_time");

	if (!isValidDueDateInput(due)) {
		return interaction.reply({
			content:
				"Invalid due date. Please include a full date with year, e.g., 'November 7, 2025'.",
			ephemeral: true,
			components: [
				new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setCustomId("hw_retry_modal")
						.setStyle(ButtonStyle.Primary)
						.setLabel("Re-open input")
				),
			],
		});
	}

	session.pending = {
		title,
		due,
		time,
		classKey: "chan 9/10",
		day: "A",
		period: "10",
	};

	await interaction.reply({
		content: `Event: **${title}**\nDue: ${due}${time ? ` at ${time}` : ""}\nPick class/day/period:`,
		ephemeral: true,
		components: [...buildSelectionRows({}), ...buildConfirmRows()],
	});
}

async function handleSelectUpdate(interaction) {
	const session = sessions.get(interaction.user.id);
	if (!session)
		return interaction.reply({
			content: "Session expired.",
			ephemeral: true,
		});

	const value = interaction.values[0];
	if (interaction.customId === "hw_class") session.pending.classKey = value;
	if (interaction.customId === "hw_day") session.pending.day = value;
	if (interaction.customId === "hw_period") session.pending.period = value;
	if (interaction.customId === "hw_schedule") session.scheduleType = value;

	await interaction.update({
		content: interaction.message.content,
		components: interaction.message.components,
	});
}

async function handleButtonPress(interaction) {
	const session = sessions.get(interaction.user.id);
	if (!session)
		return interaction.reply({
			content: "Session expired.",
			ephemeral: true,
		});

	const { customId } = interaction;
	if (customId === "hw_retry_modal") {
		await interaction.showModal(buildModal());
		return;
	}

	if (customId === "hw_cancel") {
		sessions.delete(interaction.user.id);
		await interaction.update({ content: "Canceled.", components: [] });
		return;
	}

	if (customId === "hw_save") {
		const event = computeEvent(session.pending, session.scheduleType);
		session.events.push(event);
		session.pending = {};
		await interaction.update({
			content: `Saved. Current events: ${session.events.length}\nChoose next action:`,
			components: buildNextRows(),
		});
		return;
	}

	if (customId === "hw_add") {
		await interaction.update({
			content: "Add another event",
			components: [],
		});
		await interaction.followUp({
			ephemeral: true,
			content: "Opening modal...",
		});
		await interaction.showModal(buildModal());
		return;
	}

	if (customId === "hw_done") {
		await finalizeAndPost(interaction, session);
	}
}

function isValidDueDateInput(input) {
	if (!input || typeof input !== "string") return false;
	const cleaned = input.trim();
	const match = cleaned.match(/^(\p{L}+)\s+(\d{1,2}),\s*(\d{4})$/u);
	if (!match) return false;
	const monthName = match[1].toLowerCase();
	const day = Number.parseInt(match[2], 10);
	const year = Number.parseInt(match[3], 10);
	if (Number.isNaN(day) || Number.isNaN(year)) return false;
	const months = [
		"january",
		"february",
		"march",
		"april",
		"may",
		"june",
		"july",
		"august",
		"september",
		"october",
		"november",
		"december",
	];
	if (!months.includes(monthName)) return false;
	return day >= 1 && day <= 31 && year >= 1970 && year <= 9999;
}

function shouldStart(interaction) {
	return (
		interaction.isChatInputCommand() &&
		interaction.commandName === "sendhomework"
	);
}

async function startSession(interaction) {
	const format = interaction.options.getString("format");
	const target =
		interaction.options.getChannel("target") ?? interaction.channel;
	sessions.set(interaction.user.id, {
		format,
		channelId: target.id,
		events: [],
		pending: {},
		scheduleType: SCHEDULE_TYPES.REGULAR,
	});
	await interaction.showModal(buildModal());
}

function computeEvent(pending, scheduleType) {
	const { title, due, time, classKey, day } = pending;
	const date = parseMonthDayToDate(due);

	let timeString = time && time.trim() !== "" ? time.trim() : null;
	if (!timeString) {
		const period = defaultPeriodFor({
			classKey,
			day,
			fallback: Number.parseInt((classKey.match(/(\d+)/u) ?? [])[0] ?? "8", 10),
		});
		timeString = getStartTimeForPeriod({ period, scheduleType });
	}

	const [hh, mm, ss] = timeString.split(":").map((n) => Number.parseInt(n, 10));
	date.setHours(hh, mm, ss, 0);
	return { title, classKey, dueTimestamp: date.getTime() };
}

function defaultPeriodFor({ classKey, day, fallback }) {
	const match = classKey.match(/(\d+)\/(\d+)/u);
	if (!match) return fallback;
	const first = Number.parseInt(match[1], 10);
	const second = Number.parseInt(match[2], 10);
	if (classKey.startsWith("chan ")) {
		if (classKey.includes("9/10")) return day === "B" ? first : second; // 9 on B, 10 on A
		if (classKey.includes("8/9")) return first; // 8 is beginning on both A and B per example
	}

	return first;
}

function parseMonthDayToDate(input) {
	const months = [
		"january",
		"february",
		"march",
		"april",
		"may",
		"june",
		"july",
		"august",
		"september",
		"october",
		"november",
		"december",
	];
	const parts = input.trim().replaceAll(",", "").split(/\s+/u);
	const monthIndex = months.indexOf(parts[0].toLowerCase());
	const day = Number.parseInt(parts[1], 10);
	const inferredYear =
		parts.length >= 3
			? Number.parseInt(parts[2], 10)
			: new Date().getFullYear();
	const date = new Date(inferredYear, monthIndex, day, 0, 0, 0, 0);
	return date;
}

async function buildFinalPayload({ format, events, headerClass }) {
	if (format === "text") {
		return { content: renderText({ events, headerClass }) };
	}

	if (format === "embed") {
		return renderEmbed({ events, headerClass });
	}

	return renderImage({ events, headerClass });
}

async function finalizeAndPost(interaction, session) {
	const targetChannel = await interaction.client.channels.fetch(
		session.channelId
	);
	const payload = await buildFinalPayload({
		format: session.format,
		events: session.events,
		headerClass: mostLikelyClass(session.events),
	});
	await targetChannel.send(payload);
	sessions.delete(interaction.user.id);
	await interaction.update({ content: "Posted homework.", components: [] });
}

function mostLikelyClass(events) {
	if (!events || events.length === 0) return undefined;
	const counts = new Map();
	for (const event of events) {
		counts.set(event.classKey, (counts.get(event.classKey) ?? 0) + 1);
	}

	let best;
	let max = -1;
	for (const [k, v] of counts.entries()) {
		if (v > max) {
			best = k;
			max = v;
		}
	}

	return best ?? events[0].classKey;
}
