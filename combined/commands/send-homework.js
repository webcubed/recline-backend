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

// Optional: map class keys to section names for display next to class
const SECTION_NAME_MAP = new Map([["chan 9/10", "Section 7"]]);

function classLabelFor(key) {
	const section = SECTION_NAME_MAP.get(key);
	return section ? `${key} — ${section}` : key;
}

const CLASS_KEYS = [
	"chan 8/9",
	"chan 9/10",
	"hua 5/6",
	"hua 7/8",
	"maggio 2/3",
	"maggio 3/4",
	"maggio 6/7",
];

const CLASS_OPTIONS = CLASS_KEYS.map((key) => ({
	label: classLabelFor(key),
	value: key,
}));

const DAY_OPTIONS = [
	{ label: "A Day", value: "A" },
	{ label: "B Day", value: "B" },
];

const SCHEDULE_OPTIONS = [
	{ label: "Regular", value: SCHEDULE_TYPES.REGULAR },
	{ label: "Conference", value: SCHEDULE_TYPES.CONFERENCE },
];

// Period options removed; times are inferred from class + A/B day + schedule

function buildModal(customId = "hw_modal") {
	const modal = new ModalBuilder()
		.setCustomId(customId)
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
	scheduleValue = SCHEDULE_TYPES.REGULAR,
}) {
	const classSelect = new StringSelectMenuBuilder()
		.setCustomId("hw_class")
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(CLASS_OPTIONS)
		.setPlaceholder(classLabelFor(classValue));

	const daySelect = new StringSelectMenuBuilder()
		.setCustomId("hw_day")
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(DAY_OPTIONS)
		.setPlaceholder(dayValue);

	const scheduleSelect = new StringSelectMenuBuilder()
		.setCustomId("hw_schedule")
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(SCHEDULE_OPTIONS)
		.setPlaceholder(scheduleValue);

	return [
		new ActionRowBuilder().addComponents(classSelect),
		new ActionRowBuilder().addComponents(daySelect),
		new ActionRowBuilder().addComponents(scheduleSelect),
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
	};

	await interaction.reply({
		content: `Event: **${title}**\nDue: ${due}${time ? ` at ${time}` : ""}\nPick class/day/schedule:`,
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
	if (interaction.customId === "hw_schedule") session.scheduleType = value;

	// Rebuild the selection rows to reflect current selections
	await interaction.update({
		content: interaction.message.content,
		components: [
			...buildSelectionRows({
				classValue: session.pending.classKey,
				dayValue: session.pending.day,
				scheduleValue: session.scheduleType,
			}),
			...buildConfirmRows(),
		],
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
		await interaction.showModal(buildModal());
		return;
	}

	if (customId === "hw_done") {
		// Image rendering or network sends may exceed 3s; acknowledge first.
		await interaction.deferUpdate();
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
		const selectedPeriod = defaultPeriodFor({
			classKey,
			day,
			fallback: Number.parseInt((classKey.match(/(\d+)/u) ?? [])[0] ?? "8", 10),
		});

		timeString = getStartTimeForPeriod({
			period: selectedPeriod,
			scheduleType,
		});
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
		if (classKey.includes("8/9")) return first; // 8 on both A and B
	}

	// Maggio rules
	if (classKey.startsWith("maggio ")) {
		if (classKey.includes("2/3")) return day === "A" ? 3 : first; // Period 3 on A, 2 on B
		if (classKey.includes("3/4")) return day === "B" ? 3 : second; // Period 3 on B, 4 on A
		if (classKey.includes("6/7")) return day === "A" ? 7 : first; // Period 7 on A, 6 on B
	}

	// Hua rules
	if (classKey.startsWith("hua ")) {
		if (classKey.includes("5/6")) return day === "A" ? 6 : first; // Period 6 on A, 5 on B
		if (classKey.includes("7/8")) return day === "B" ? 7 : second; // Period 7 on B, 8 on A
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

	// Choose the correct responder based on whether we've already acknowledged
	const respond = (data) =>
		interaction.deferred || interaction.replied
			? interaction.editReply(data)
			: interaction.update(data);
	if (!session.events || session.events.length === 0) {
		await respond({
			content: "No events saved yet. Add at least one, or cancel.",
			components: [
				...buildSelectionRows({
					classValue: session.pending?.classKey ?? "chan 9/10",
					dayValue: session.pending?.day ?? "A",
					scheduleValue: session.scheduleType,
				}),
				...buildConfirmRows(),
			],
		});
		return;
	}

	const payload = await buildFinalPayload({
		format: session.format,
		events: session.events,
		headerClass: classLabelFor(mostLikelyClass(session.events)),
	});
	await targetChannel.send(payload);
	sessions.delete(interaction.user.id);
	await respond({ content: "Posted homework.", components: [] });
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
