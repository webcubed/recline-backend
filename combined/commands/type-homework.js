/* eslint-disable sort-imports */
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	PermissionsBitField,
	SlashCommandBuilder,
} from "discord.js";
import { zonedTimeToUtc } from "date-fns-tz";
import { renderEmbed, renderImage, renderText } from "./homework-renderers.js";
import { getStartTimeForPeriod } from "./bell-schedule.js";
import { trackImagePost } from "./homework-tracker.js";
import {
	allowedSectionsForChannel,
	hasMonitorRole,
	isChannelAllowed,
} from "./allowed-channels.js";
import {
	addEvents,
	ensureChannel,
	loadEventsStore,
	saveEventsStore,
} from "./homework-events-store.js";

// Section -> classKey mapping (reverse of the Section name mapping used elsewhere)
const SECTION_TO_CLASSKEY = new Map([
	[1, "maggio 2/3"],
	[2, "maggio 3/4"],
	[3, "hua 5/6"],
	[4, "maggio 6/7"],
	[5, "chan 8/9"],
	[6, "hua 7/8"],
	[7, "chan 9/10"],
]);

function classLabelFor(key) {
	const section =
		key === "maggio 2/3"
			? 1
			: key === "maggio 3/4"
				? 2
				: key === "hua 5/6"
					? 3
					: key === "maggio 6/7"
						? 4
						: key === "chan 8/9"
							? 5
							: key === "hua 7/8"
								? 6
								: key === "chan 9/10"
									? 7
									: undefined;
	return section ? `${key} — Section ${section}` : key;
}

export const typeHomeworkCommand = new SlashCommandBuilder()
	.setName("typehomework")
	.setDescription("Type homework as text lines; store or post it")
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
			.setRequired(false)
	)
	.addBooleanOption((opt) =>
		opt
			.setName("storeonly")
			.setDescription(
				"Store events only (don't post now). Defaults to true in allowed channels."
			)
			.setRequired(false)
	);

export async function handleTypeHomework(interaction) {
	if (
		!interaction.isChatInputCommand() ||
		interaction.commandName !== "typehomework"
	) {
		return;
	}

	const format = interaction.options.getString("format");
	const requestedStoreOnly = interaction.options.getBoolean("storeonly");
	const target =
		interaction.options.getChannel("target") ?? interaction.channel;

	// Permission check for posting
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

	// We'll collect messages in the current channel from this author
	const { channel } = interaction;
	const authorId = interaction.user.id;

	// Try to delete collected messages afterwards
	const canBotDelete = channel
		.permissionsFor(interaction.client.user)
		?.has(PermissionsBitField.Flags.ManageMessages);

	await interaction.reply({
		ephemeral: true,
		content: [
			"Typing mode started. Send messages here with:",
			"- First line: section number (1-7)",
			"- Then one or more lines, each: title --- Month D, YYYY --- a|b --- [optional] HH:MM[:SS]",
			"- Send 'end' on its own line when finished.",
			"Non-matching lines will be deleted and you'll get a DM explaining why.",
		].join("\n"),
	});

	const events = [];
	let classKey; // Derived from section
	let sectionNumber; // Numeric section (1-7)
	const collectedMessageIds = [];
	let done = false;

	const collector = channel.createMessageCollector({
		filter: (m) => m.author?.id === authorId,
		time: 5 * 60 * 1000,
	});

	collector.on("collect", async (m) => {
		collectedMessageIds.push(m.id);
		const lines = m.content
			.split(/\r?\n/u)
			.map((s) => s.trim())
			.filter(Boolean);
		const dms = [];

		for (const line of lines) {
			if (!classKey) {
				// Expect a section number as the first non-empty line across all messages
				const sec = Number.parseInt(line, 10);
				if (!Number.isFinite(sec) || !SECTION_TO_CLASSKEY.has(sec)) {
					dms.push(
						`Section parse error: expected a section number (1-7). Got line: "${line}"`
					);
				} else {
					classKey = SECTION_TO_CLASSKEY.get(sec);
					sectionNumber = sec;
				}

				continue;
			}

			if (line.toLowerCase() === "end") {
				done = true;
				collector.stop("ended");
				break;
			}

			try {
				const parsed = parseEventLine(line, classKey);
				if (parsed.ok) {
					events.push(parsed.event);
				} else {
					dms.push(parsed.error || `Couldn't parse line: "${line}"`);
				}
			} catch (error) {
				dms.push(
					`Exception while parsing: ${error?.message ?? String(error)} | line: "${line}"`
				);
			}
		}

		// Delete message in-channel if possible
		if (canBotDelete) {
			try {
				await m.delete();
			} catch {}
		}

		// DM user about any errors
		if (dms.length > 0) {
			try {
				await interaction.user.send(dms.join("\n"));
			} catch {}
		}

		// Update ephemeral preview if section is set (show 0+ events)
		if (classKey) {
			try {
				const preview = buildPreviewContent({ events, classKey, final: false });
				await interaction.editReply({ content: preview });
			} catch {}
		}
	});

	collector.on("end", async () => {
		if (!classKey || events.length === 0) {
			await interaction.followUp({
				ephemeral: true,
				content: classKey
					? "No valid events were collected."
					: "No valid section number was provided.",
			});
			return;
		}

		// Decide behavior: store to events DB or post immediately
		const storeOnly = requestedStoreOnly ?? true;
		const inAllowedChannel = isChannelAllowed(interaction.channel.id);
		const userHasRole = hasMonitorRole(interaction.member);
		if (storeOnly) {
			if (!inAllowedChannel || !userHasRole) {
				await interaction.followUp({
					ephemeral: true,
					content: [
						"Not allowed to store in this channel.",
						inAllowedChannel
							? "You need the monitor role to store."
							: "This channel isn't configured for sections.",
						"If you just want to test-post, re-run with storeonly = false.",
					].join("\n"),
				});
				return;
			}

			try {
				const store = await loadEventsStore();
				const allowedSections = allowedSectionsForChannel(
					interaction.channel.id
				);
				ensureChannel(store, interaction.channel.id, allowedSections);
				addEvents(store, interaction.channel.id, String(sectionNumber), events);
				await saveEventsStore(store);
				await interaction.followUp({
					ephemeral: true,
					content: `Saved ${events.length} event${events.length === 1 ? "" : "s"} for Section ${sectionNumber} in this channel.`,
				});
				return;
			} catch (error) {
				await interaction.followUp({
					ephemeral: true,
					content: `Failed to save events: ${error?.message ?? "unknown error"}`,
				});
				return;
			}
		}

		// Echo a summary before sending
		try {
			const preview = buildPreviewContent({ events, classKey, final: true });
			await interaction.followUp({ ephemeral: true, content: preview });
		} catch {}

		const payload = await buildFinalPayload({
			format,
			events,
			headerClass: classLabelFor(classKey),
			sectionNumber,
		});

		let sent;
		try {
			sent = await target.send(payload);
		} catch (error) {
			await interaction.followUp({
				ephemeral: true,
				content: `Failed to post in <#${target.id}>: ${error?.message ?? "unknown error"}`,
			});
			return;
		}

		if (format === "image") {
			await trackImagePost({
				channelId: sent.channelId,
				messageId: sent.id,
				events,
				classKey,
			});
		}

		await interaction.followUp({
			ephemeral: true,
			content: done
				? "Posted homework from typed lines."
				: "Time expired; posted what was collected.",
		});
	});
}

// ------------ Helpers ------------------------------------------------------

export function parseEventLine(line, classKey) {
	// Title --- Month D, YYYY --- a|b --- [HH:MM(:SS)]
	const raw = String(line ?? "");
	const cleaned = raw.replaceAll("\\", "");
	const parts = cleaned.split(/\s*---\s*/u);
	if (parts.length < 3 || parts.length > 4) {
		return {
			ok: false,
			error: `Expected 3 or 4 parts separated by ---. Got ${parts.length} parts.\nLine: "${raw}"`,
		};
	}

	const title = parts[0]?.trim();
	const due = parts[1]?.trim();
	const dayToken = parts[2]?.trim().toLowerCase();
	const timeOverride = parts[3]?.trim() ?? "";
	if (!title) return { ok: false, error: `Missing title. Line: "${raw}"` };
	if (!isValidDueDateInput(due))
		return {
			ok: false,
			error: `Invalid due date: "${due}". Line: "${raw}"`,
		};
	if (dayToken !== "a" && dayToken !== "b")
		return {
			ok: false,
			error: `Day must be 'a' or 'b', got: "${dayToken}". Line: "${raw}"`,
		};

	const day = dayToken.toUpperCase();
	const event = computeEvent({ title, due, time: timeOverride, classKey, day });
	if (!event) return { ok: false, error: "Failed to compute event" };
	return { ok: true, event };
}

function computeEvent(pending) {
	const { title, due, time, classKey, day } = pending;
	const date = parseMonthDayToDate(due); // Local components only

	let timeString = normalizeTime(time);
	if (!timeString) {
		const selectedPeriod = defaultPeriodFor({
			classKey,
			day,
			fallback: Number.parseInt((classKey.match(/(\d+)/u) ?? [])[0] ?? "8", 10),
		});

		timeString = getStartTimeForPeriod({ period: selectedPeriod });
	}

	const [hh, mm, ss] = timeString.split(":").map((n) => Number.parseInt(n, 10));
	// Build a zoned time in America/New_York and convert to UTC millis
	const year = date.getFullYear();
	const month = date.getMonth();
	const dayNumber = date.getDate();
	const zoned = new Date(year, month, dayNumber, hh, mm, ss ?? 0, 0);
	const utc = zonedTimeToUtc(zoned, "America/New_York");
	return { title, classKey, dueTimestamp: utc.getTime() };
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

function normalizeTime(input) {
	if (!input) return null;
	const s = String(input).trim().toLowerCase();
	if (!s) return null;
	// Try HH:MM[:SS] 24h
	let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/u);
	if (m) {
		const hh = Number.parseInt(m[1], 10);
		const mm = Number.parseInt(m[2], 10);
		const ss = m[3] ? Number.parseInt(m[3], 10) : 0;
		if (hh <= 23 && mm <= 59 && ss <= 59)
			return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
	}

	// Try HHMM 24h
	m = s.match(/^(\d{3,4})$/u);
	if (m) {
		const v = m[1];
		const hh = Number.parseInt(
			v.length === 3 ? v.slice(0, 1) : v.slice(0, 2),
			10
		);
		const mm = Number.parseInt(v.length === 3 ? v.slice(1) : v.slice(2), 10);
		if (hh <= 23 && mm <= 59)
			return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
	}

	// Try h[:mm] am/pm
	m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p)\.?m\.?$/u);
	if (m) {
		let hh = Number.parseInt(m[1], 10);
		const mm = m[2] ? Number.parseInt(m[2], 10) : 0;
		const pm = m[3] === "p";
		if (hh === 12) hh = 0;
		if (pm) hh += 12;
		if (hh <= 23 && mm <= 59)
			return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
	}

	return null;
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

async function buildFinalPayload({
	format,
	events,
	headerClass,
	sectionNumber,
}) {
	if (format === "text") {
		return withEditButton(
			{ content: renderText({ events, headerClass }) },
			sectionNumber
		);
	}

	if (format === "embed") {
		return withEditButton(renderEmbed({ events, headerClass }), sectionNumber);
	}

	return withEditButton(
		await renderImage({ events, headerClass }),
		sectionNumber
	);
}

function buildPreviewContent({ events, classKey, final = false }) {
	const header = final
		? "Summary before posting:"
		: "Collected so far. You can keep typing more lines or send 'end' to finish.";
	const text = renderText({
		events: [...events].sort((a, b) => a.dueTimestamp - b.dueTimestamp),
		headerClass: classLabelFor(classKey),
	});
	const count = events.length;
	return [header, `Events: ${count}`, "", text].join("\n");
}

function withEditButton(payload, sectionNumber) {
	const section = Number.parseInt(sectionNumber, 10);
	const customId =
		Number.isFinite(section) && section >= 1 && section <= 7
			? `hw_add_sec_${section}`
			: "hw_add_sec_1"; // Fallback, though section should always be set here
	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(customId)
			.setStyle(ButtonStyle.Primary)
			.setLabel("Add/Edit")
	);
	if (payload.components && Array.isArray(payload.components)) {
		return { ...payload, components: [...payload.components, row] };
	}

	return { ...payload, components: [row] };
}
