/* eslint-disable sort-imports */
import { formatInTimeZone, utcToZonedTime, zonedTimeToUtc } from "date-fns-tz";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	InteractionType,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { renderEmbed, renderImage, renderText } from "./homework-renderers.js";
import {
	ensureChannel,
	listAllEvents,
	loadEventsStore,
	saveEventsStore,
	setLastPostForSection,
	removeEvents,
} from "./homework-events-store.js";
import {
	allowedSectionsForChannel,
	hasMonitorRole,
	isChannelAllowed,
} from "./allowed-channels.js";
import { getStartTimeForPeriod } from "./bell-schedule.js";
import { trackImagePost, untrack } from "./homework-tracker.js";
import {
	getPostRecord,
	upsertPostRecord,
	listChannelPostRecords,
	deleteChannelPostRecords,
} from "./post-index-store.js";

const ET = "America/New_York";

const CUSTOM_ID_DAILY_BUTTON = "hw_daily_add"; // Legacy (no section)
const CUSTOM_ID_DAILY_BUTTON_SEC_PREFIX = "hw_daily_add_sec_"; // E.g., hw_daily_add_sec_7
const CUSTOM_ID_DAILY_MANAGE = "hw_daily_manage"; // Legacy (no section)
const CUSTOM_ID_DAILY_MANAGE_SEC_PREFIX = "hw_daily_manage_sec_"; // E.g., hw_daily_manage_sec_7
const CUSTOM_ID_ADHOC_PREFIX = "hw_add_sec_"; // E.g., hw_add_sec_5 for Section 5 posts
const CUSTOM_ID_MODAL_DAILY = "hw_daily_add_modal"; // Legacy modal
const CUSTOM_ID_MODAL_DAILY_SEC_PREFIX = "hw_daily_add_modal_sec_"; // E.g., hw_daily_add_modal_sec_7
const CUSTOM_ID_MODAL_ADHOC_PREFIX = "hw_add_modal_sec_"; // E.g., hw_add_modal_sec_5 or hw_add_modal_sec_5_123456
const CUSTOM_ID_DAILY_RM_SELECT = "hw_daily_rm_select";

export function scheduleDailyPoster(client) {
	const scheduleNext = () => {
		const now = new Date();
		const zoned = utcToZonedTime(now, ET);
		const target = new Date(zoned);
		target.setHours(15, 35, 0, 0); // 3:35 PM ET
		if (target <= zoned) target.setDate(target.getDate() + 1);
		const delay = target.getTime() - zoned.getTime();
		setTimeout(async () => {
			try {
				await postDailyForAll(client);
			} finally {
				scheduleNext();
			}
		}, delay);
	};

	scheduleNext();
}

// In-memory per-process lock to prevent overlapping reposts per channel
const channelPostLocks = new Set();

export async function postDailyForAll(client) {
	const store = await loadEventsStore();
	const guilds = client.guilds.cache;
	const tasks = [];
	for (const guild of guilds.values()) {
		const channels = guild.channels.cache;
		for (const channel of channels.values()) {
			if (!channel?.isTextBased?.()) continue;
			const allowed = allowedSectionsForChannel(channel.id);
			if (allowed.length === 0) continue;
			tasks.push(postDailyForChannel({ client, channelId: channel.id, store }));
		}
	}

	await Promise.allSettled(tasks);
	await saveEventsStore(store);
}

async function postDailyForSection({ client, channelId, store, section }) {
	const channel = await client.channels.fetch(channelId);
	if (!channel?.isTextBased?.()) return null;

	const startMs = getEtStartOfTodayUtcMs();
	const todayYmd = formatInTimeZone(new Date(), ET, "yyyy-MM-dd");
	const sectionKey = String(section);
	const list = store.channels?.[channelId]?.events?.[sectionKey] || [];
	const filtered = list.filter((event) => event.dueTimestamp >= startMs);
	if (filtered.length === 0) return null;

	const classKey = SECTION_TO_CLASSKEY.get(section);
	const header = `${classKey ? `${classKey} — Section ${section}` : `Section ${section}`} — ${todayYmd}`;
	const payload = await renderForDaily({
		events: filtered,
		headerClass: header,
	});
	payload.components = [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`${CUSTOM_ID_DAILY_BUTTON_SEC_PREFIX}${section}`)
				.setStyle(ButtonStyle.Primary)
				.setLabel("Add/Edit"),
			new ButtonBuilder()
				.setCustomId(`${CUSTOM_ID_DAILY_MANAGE_SEC_PREFIX}${section}`)
				.setStyle(ButtonStyle.Secondary)
				.setLabel("Manage")
		),
	];

	try {
		const sent = await channel.send(payload);
		setLastPostForSection({
			store,
			channelId,
			section,
			messageId: sent.id,
			dateYmd: todayYmd,
		});
		try {
			await trackImagePost({
				channelId: sent.channelId,
				messageId: sent.id,
				events: filtered,
				classKey: header,
			});
		} catch {}

		return sent;
	} catch {
		return null;
	}
}

export async function postDailyForChannel({ client, channelId, store }) {
	const allowed = allowedSectionsForChannel(channelId);
	ensureChannel(store, channelId, allowed);
	// Compute ET start-of-today (UTC millis) and prune past-due events from the store
	const startMs = getEtStartOfTodayUtcMs();
	prunePastEvents({ store, channelId, cutoffMs: startMs });
	const tasks = allowed.map((section) =>
		postDailyForSection({ client, channelId, store, section })
	);
	const results = await Promise.allSettled(tasks);
	let any = null;
	for (const r of results) {
		if (r.status === "fulfilled" && r.value) any = r.value;
	}

	return any;
}

async function renderForDaily({ events, headerClass }) {
	try {
		return await renderImage({ events, headerClass });
	} catch {}

	try {
		return renderEmbed({ events, headerClass });
	} catch {}

	return { content: renderText({ events, headerClass }) };
}

export async function bumpDailyIfNeeded({ client, channelId, authorIsBot }) {
	try {
		if (authorIsBot) return false;
		const allowed = allowedSectionsForChannel(channelId);
		if (allowed.length === 0) return false;
		if (channelPostLocks.has(channelId)) return false;
		channelPostLocks.add(channelId);
		const store = await loadEventsStore();
		ensureChannel(store, channelId, allowed);
		const chData = store.channels?.[channelId];
		const todayYmd = formatInTimeZone(new Date(), ET, "yyyy-MM-dd");
		// Delete today's per-section daily posts only; preserve history
		const bySection = chData?.lastPosts || {};
		const deletionTasks = [];
		for (const [, entry] of Object.entries(bySection)) {
			if (entry?.date !== todayYmd) continue;
			const lastId = entry?.id;
			if (!lastId) continue;
			deletionTasks.push(
				(async () => {
					try {
						const channel = await client.channels.fetch(channelId);
						const message = await channel.messages.fetch(lastId);
						try {
							untrack(lastId);
						} catch {}

						await message.delete();
					} catch {}
				})()
			);
		}

		// Legacy: also delete single-daily post from today if present
		if (chData?.lastPostId && chData?.lastPostDate === todayYmd) {
			const legacyId = chData.lastPostId;
			deletionTasks.push(
				(async () => {
					try {
						const channel = await client.channels.fetch(channelId);
						const message = await channel.messages.fetch(legacyId);
						try {
							untrack(legacyId);
						} catch {}

						await message.delete();
					} catch {}
				})()
			);
		}

		await Promise.allSettled(deletionTasks);

		// Also delete any ad-hoc posts previously sent in this channel
		try {
			await deleteAdhocPostsForChannel({ client, channelId });
		} catch {}

		await postDailyForChannel({ client, channelId, store });
		await saveEventsStore(store);
		return true;
	} catch {
		return false;
	} finally {
		channelPostLocks.delete(channelId);
	}
}

// eslint-disable-next-line complexity
export async function handleDailyInteraction(interaction) {
	try {
		if (interaction.isButton() && interaction.customId) {
			if (interaction.customId === CUSTOM_ID_DAILY_BUTTON) {
				if (!isChannelAllowed(interaction.channel.id)) {
					await interaction.reply({
						content: "This channel isn't configured for homework.",
						ephemeral: true,
					});
					return true;
				}

				if (!hasMonitorRole(interaction.member)) {
					await interaction.reply({
						content: "You need the monitor role to edit.",
						ephemeral: true,
					});
					return true;
				}

				await interaction.showModal(buildAddModal({ includeSection: false }));
				return true;
			}

			// Section-scoped daily Add/Edit button
			if (interaction.customId.startsWith(CUSTOM_ID_DAILY_BUTTON_SEC_PREFIX)) {
				if (!isChannelAllowed(interaction.channel.id)) {
					await interaction.reply({
						content: "This channel isn't configured for homework.",
						ephemeral: true,
					});
					return true;
				}

				if (!hasMonitorRole(interaction.member)) {
					await interaction.reply({
						content: "You need the monitor role to edit.",
						ephemeral: true,
					});
					return true;
				}

				const sec = Number.parseInt(
					interaction.customId.slice(CUSTOM_ID_DAILY_BUTTON_SEC_PREFIX.length),
					10
				);
				if (!Number.isFinite(sec) || sec < 1 || sec > 7) {
					await interaction.reply({
						content: "Invalid section.",
						ephemeral: true,
					});
					return true;
				}

				const modalId = `${CUSTOM_ID_MODAL_DAILY_SEC_PREFIX}${sec}`;
				await interaction.showModal(
					buildAddModal({ includeSection: false, modalId })
				);
				return true;
			}

			if (interaction.customId.startsWith(CUSTOM_ID_ADHOC_PREFIX)) {
				if (!isChannelAllowed(interaction.channel.id)) {
					await interaction.reply({
						content: "This channel isn't configured for homework.",
						ephemeral: true,
					});
					return true;
				}

				if (!hasMonitorRole(interaction.member)) {
					await interaction.reply({
						content: "You need the monitor role to edit.",
						ephemeral: true,
					});
					return true;
				}

				const section = Number.parseInt(
					interaction.customId.slice(CUSTOM_ID_ADHOC_PREFIX.length),
					10
				);
				if (!Number.isFinite(section) || section < 1 || section > 7) {
					await interaction.reply({
						content: "Invalid section.",
						ephemeral: true,
					});
					return true;
				}

				const messageId = interaction.message?.id;
				const modalId = `${CUSTOM_ID_MODAL_ADHOC_PREFIX}${section}${messageId ? `_${messageId}` : ""}`;
				await interaction.showModal(
					buildAddModal({ includeSection: false, modalId })
				);
				return true;
			}

			if (
				interaction.customId === CUSTOM_ID_DAILY_MANAGE ||
				interaction.customId.startsWith(CUSTOM_ID_DAILY_MANAGE_SEC_PREFIX)
			) {
				if (!isChannelAllowed(interaction.channel.id)) {
					await interaction.reply({
						content: "This channel isn't configured for homework.",
						ephemeral: true,
					});
					return true;
				}

				if (!hasMonitorRole(interaction.member)) {
					await interaction.reply({
						content: "You need the monitor role to manage.",
						ephemeral: true,
					});
					return true;
				}

				// Build a select menu of current events (today onward) for removal
				const store = await loadEventsStore();
				const allowed = allowedSectionsForChannel(interaction.channel.id);
				ensureChannel(store, interaction.channel.id, allowed);
				const cutoff = getEtStartOfTodayUtcMs();
				let sectionFilter;
				if (
					interaction.customId.startsWith(CUSTOM_ID_DAILY_MANAGE_SEC_PREFIX)
				) {
					sectionFilter = Number.parseInt(
						interaction.customId.slice(
							CUSTOM_ID_DAILY_MANAGE_SEC_PREFIX.length
						),
						10
					);
				}

				let all = listAllEvents(store, interaction.channel.id).filter(
					(event) => event.dueTimestamp >= cutoff
				);
				if (Number.isFinite(sectionFilter)) {
					all = all.filter((eventItem) => eventItem.section === sectionFilter);
				}

				all = all.slice(0, 25);
				if (all.length === 0) {
					await interaction.reply({
						content: "No events to manage.",
						ephemeral: true,
					});
					return true;
				}

				const { StringSelectMenuBuilder } = await import("discord.js");
				const menu = new StringSelectMenuBuilder()
					.setCustomId(CUSTOM_ID_DAILY_RM_SELECT)
					.setMinValues(1)
					.setMaxValues(Math.min(25, all.length))
					.setPlaceholder("Select events to remove")
					.addOptions(
						all.map((ev) => ({
							label: `${String(ev.title).slice(0, 80)}`,
							description: `${formatInTimeZone(new Date(ev.dueTimestamp), ET, "MM/dd/yyyy")} — Sec ${ev.section}`,
							value: `${ev.section}|${ev.dueTimestamp}|${encodeURIComponent(String(ev.title))}`,
						}))
					);
				await interaction.reply({
					content: "Select one or more events to remove.",
					ephemeral: true,
					components: [new ActionRowBuilder().addComponents(menu)],
				});
				return true;
			}
		}

		if (
			interaction.type === InteractionType.ModalSubmit &&
			(interaction.customId === CUSTOM_ID_MODAL_DAILY ||
				interaction.customId.startsWith(CUSTOM_ID_MODAL_DAILY_SEC_PREFIX) ||
				interaction.customId.startsWith(CUSTOM_ID_MODAL_ADHOC_PREFIX))
		) {
			await handleAddModalSubmit(interaction);
			return true;
		}

		// Handle daily removal select
		if (
			interaction.isStringSelectMenu?.() &&
			interaction.customId === CUSTOM_ID_DAILY_RM_SELECT
		) {
			if (
				!isChannelAllowed(interaction.channel.id) ||
				!hasMonitorRole(interaction.member)
			) {
				await interaction.reply({ content: "Not allowed.", ephemeral: true });
				return true;
			}

			const selections = interaction.values || [];
			const selectedSections = new Set();
			const store = await loadEventsStore();
			for (const v of selections) {
				const sec = parseSectionFromRemovalValue(v);
				if (Number.isFinite(sec)) selectedSections.add(sec);
				processRemovalSelection({
					store,
					channelId: interaction.channel.id,
					value: v,
				});
			}

			await saveEventsStore(store);
			if (selectedSections.size === 1) {
				const [onlySection] = [...selectedSections.values()];
				await refreshDailyAfterAdd(interaction, store, onlySection);
			} else {
				await refreshDailyAfterAdd(interaction, store);
			}

			return true;
		}
	} catch (error) {
		try {
			await (interaction.deferred || interaction.replied
				? interaction.followUp({ content: "Edit failed.", ephemeral: true })
				: interaction.reply({ content: "Edit failed.", ephemeral: true }));
		} catch {}

		console.error("[daily-edit] error", error);
		return true;
	}

	return false;
}

// Helper: apply one selection removal tuple "section|due|title"
function processRemovalSelection({ store, channelId, value }) {
	try {
		const [sectionString, dueString, encTitle] = String(value).split("|");
		const section = Number.parseInt(sectionString, 10);
		const dueTimestamp = Number.parseInt(dueString, 10);
		const title = decodeURIComponent(encTitle ?? "");
		if (!Number.isFinite(section) || !Number.isFinite(dueTimestamp)) return;

		removeEvents(
			store,
			channelId,
			String(section),
			(ev) => ev.title === title && ev.dueTimestamp === dueTimestamp
		);
	} catch {}
}

function parseSectionFromRemovalValue(value) {
	try {
		const [sectionString] = String(value).split("|");
		const section = Number.parseInt(sectionString, 10);
		return section;
	} catch {
		return Number.NaN;
	}
}

function buildAddModal(options) {
	const { includeSection = true, modalId } = options ?? {};
	const modal = new ModalBuilder()
		.setCustomId(modalId ?? CUSTOM_ID_MODAL_DAILY)
		.setTitle("Add homework");
	const title = new TextInputBuilder()
		.setCustomId("hw_title")
		.setLabel("Title")
		.setStyle(TextInputStyle.Short)
		.setRequired(true);
	const due = new TextInputBuilder()
		.setCustomId("hw_due")
		.setLabel("Due date (e.g., November 7, 2025)")
		.setStyle(TextInputStyle.Short)
		.setRequired(true);
	const day = new TextInputBuilder()
		.setCustomId("hw_day")
		.setLabel("Day (A or B)")
		.setStyle(TextInputStyle.Short)
		.setRequired(true);
	const time = new TextInputBuilder()
		.setCustomId("hw_time")
		.setLabel("Time override (HH:MM[:SS], optional)")
		.setStyle(TextInputStyle.Short)
		.setRequired(false);

	const rows = [
		new ActionRowBuilder().addComponents(title),
		new ActionRowBuilder().addComponents(due),
		new ActionRowBuilder().addComponents(day),
		new ActionRowBuilder().addComponents(time),
	];
	if (includeSection) {
		const section = new TextInputBuilder()
			.setCustomId("hw_section")
			.setLabel("Section (1-7)")
			.setStyle(TextInputStyle.Short)
			.setRequired(true);
		rows.unshift(new ActionRowBuilder().addComponents(section));
	}

	return modal.addComponents(...rows);
}

// eslint-disable-next-line complexity
async function handleAddModalSubmit(interaction) {
	if (
		!isChannelAllowed(interaction.channel.id) ||
		!hasMonitorRole(interaction.member)
	) {
		await interaction.reply({ content: "Not allowed.", ephemeral: true });
		return;
	}

	let section;
	let targetMessageId;
	if (interaction.customId.startsWith(CUSTOM_ID_MODAL_ADHOC_PREFIX)) {
		const rest = interaction.customId.slice(
			CUSTOM_ID_MODAL_ADHOC_PREFIX.length
		);
		if (rest.includes("_")) {
			const [sec, messageIdString] = rest.split("_");
			section = Number.parseInt(sec, 10);
			targetMessageId = messageIdString;
		} else {
			section = Number.parseInt(rest, 10);
		}
	} else if (
		interaction.customId.startsWith(CUSTOM_ID_MODAL_DAILY_SEC_PREFIX)
	) {
		const secString = interaction.customId.slice(
			CUSTOM_ID_MODAL_DAILY_SEC_PREFIX.length
		);
		section = Number.parseInt(secString, 10);
	} else {
		// Daily modal: infer section from channel's allowed sections; pick the first.
		const allowed = allowedSectionsForChannel(interaction.channel.id);
		section = allowed?.[0];
	}

	const title = interaction.fields.getTextInputValue("hw_title");
	const due = interaction.fields.getTextInputValue("hw_due");
	const day = interaction.fields
		.getTextInputValue("hw_day")
		.trim()
		.toUpperCase();
	const time = interaction.fields.getTextInputValue("hw_time");

	if (!Number.isFinite(section) || section < 1 || section > 7) {
		await interaction.reply({
			content: "Invalid or ambiguous section for this channel.",
			ephemeral: true,
		});
		return;
	}

	if (!isValidDueDateInput(due)) {
		await interaction.reply({ content: "Invalid due date.", ephemeral: true });
		return;
	}

	if (day !== "A" && day !== "B") {
		await interaction.reply({
			content: "Day must be A or B.",
			ephemeral: true,
		});
		return;
	}

	const classKey = SECTION_TO_CLASSKEY.get(section);
	let event = computeEvent({ title, due, time, classKey, day });
	const store = await loadEventsStore();
	const allowedSections = allowedSectionsForChannel(interaction.channel.id);
	ensureChannel(store, interaction.channel.id, allowedSections);
	const sectionKey = String(section);
	store.channels[interaction.channel.id].events[sectionKey] ||= [];
	// Replace-on-title: if an event with the same title exists in this section, replace it
	const list = store.channels[interaction.channel.id].events[sectionKey];
	const idxByTitle = list.findIndex((item) => item.title === event.title);
	if (idxByTitle === -1) list.push(event);
	else list[idxByTitle] = event;

	// If this was an ad-hoc edit targeting a specific message, update that original message
	if (targetMessageId) {
		try {
			const record = await getPostRecord(targetMessageId);
			if (record) {
				// For ad-hoc posts, align event classKey with the original record to avoid header drift
				event = computeEvent({
					title,
					due,
					time,
					classKey: record.classKey,
					day,
				});
				const current = Array.isArray(record.events) ? [...record.events] : [];
				const i = current.findIndex((ev) => ev.title === event.title);
				if (i === -1) current.push(event);
				else current[i] = event;
				record.events = current;
				await upsertPostRecord(record);
				const channel = await interaction.client.channels.fetch(
					record.channelId
				);
				const message = await channel.messages.fetch(record.messageId);
				let newPayload;
				if (record.format === "text") {
					newPayload = {
						content: renderText({
							events: record.events,
							headerClass: record.classKey,
						}),
					};
				} else if (record.format === "embed") {
					newPayload = renderEmbed({
						events: record.events,
						headerClass: record.classKey,
					});
				} else {
					newPayload = await renderImage({
						events: record.events,
						headerClass: record.classKey,
					});
					try {
						await trackImagePost({
							channelId: record.channelId,
							messageId: record.messageId,
							events: record.events,
							classKey: record.classKey,
						});
					} catch {}
				}

				// Preserve the Add/Edit button on the original message if it exists
				if (
					Array.isArray(message.components) &&
					message.components.length > 0
				) {
					newPayload.components = message.components;
				}

				await message.edit(newPayload);
				await interaction.reply({
					content: "Saved and updated post.",
					ephemeral: true,
				});
			} else {
				await interaction.reply({ content: "Saved.", ephemeral: true });
			}
		} catch (error) {
			await interaction.reply({
				content: `Saved, but failed to update: ${error?.message ?? "unknown"}`,
				ephemeral: true,
			});
		}

		await saveEventsStore(store);
		return;
	}

	await saveEventsStore(store);

	// If this came from daily post flow, replace last daily and post a fresh one.
	if (interaction.customId === CUSTOM_ID_MODAL_DAILY) {
		await refreshDailyAfterAdd(interaction, store);
		return;
	}

	if (interaction.customId.startsWith(CUSTOM_ID_MODAL_DAILY_SEC_PREFIX)) {
		await refreshDailyAfterAdd(interaction, store, section);
		return;
	}

	// Ad-hoc: only store, do not touch the existing post or daily
	await interaction.reply({ content: "Saved.", ephemeral: true });
}

// Helper: delete last daily message for channel (untrack + delete)
async function deleteLastDailyMessage({ client, channelId, lastId }) {
	if (!lastId) return;
	try {
		const channel = await client.channels.fetch(channelId);
		const message = await channel.messages.fetch(lastId);
		try {
			untrack(lastId);
		} catch {}

		await message.delete();
	} catch {}
}

// Helper: after saving in daily modal, refresh the daily post
async function refreshDailyAfterAdd(interaction, store, section) {
	await interaction.deferReply({ ephemeral: true });
	try {
		const channelId = interaction.channel.id;
		if (channelPostLocks.has(channelId)) {
			await interaction.editReply({
				content: "Busy, please retry in a moment.",
			});
			return;
		}

		channelPostLocks.add(channelId);
		const channelData = store.channels?.[channelId];
		// Prune any past-due events before refreshing
		prunePastEvents({ store, channelId, cutoffMs: getEtStartOfTodayUtcMs() });
		const todayYmd = formatInTimeZone(new Date(), ET, "yyyy-MM-dd");
		if (Number.isFinite(section)) {
			const entry = channelData?.lastPosts?.[String(section)];
			if (entry?.id && entry?.date === todayYmd) {
				await deleteLastDailyMessage({
					client: interaction.client,
					channelId,
					lastId: entry.id,
				});
			}
		} else if (
			channelData?.lastPostId &&
			channelData?.lastPostDate === todayYmd
		) {
			// Legacy single-daily cleanup
			await deleteLastDailyMessage({
				client: interaction.client,
				channelId,
				lastId: channelData.lastPostId,
			});
		}

		// Also remove any ad-hoc posts when refreshing daily via modal
		try {
			await deleteAdhocPostsForChannel({
				client: interaction.client,
				channelId,
			});
		} catch {}

		if (Number.isFinite(section)) {
			await postDailyForSection({
				client: interaction.client,
				channelId,
				store,
				section,
			});
		} else {
			await postDailyForChannel({
				client: interaction.client,
				channelId,
				store,
			});
		}

		await saveEventsStore(store);
		await interaction.editReply({
			content: "Added event and refreshed daily post.",
		});
	} catch (error) {
		await interaction.editReply({
			content: `Saved, but failed to refresh daily: ${error?.message ?? "unknown"}`,
		});
	} finally {
		channelPostLocks.delete(interaction.channel.id);
	}
}

// Helper: get ET midnight for today as UTC milliseconds
function getEtStartOfTodayUtcMs() {
	const now = new Date();
	const zoned = utcToZonedTime(now, ET);
	const etMidnightLocal = new Date(
		zoned.getFullYear(),
		zoned.getMonth(),
		zoned.getDate(),
		0,
		0,
		0,
		0
	);
	const utc = zonedTimeToUtc(etMidnightLocal, ET);
	return utc.getTime();
}

// Helper: remove any events older than cutoffMs from the store in-place
function prunePastEvents({ store, channelId, cutoffMs }) {
	try {
		const channel = store.channels?.[channelId];
		if (!channel?.events) return 0;
		let removed = 0;
		for (const [sectionKey, array] of Object.entries(channel.events)) {
			if (!Array.isArray(array)) continue;
			const kept = array.filter((ev) => ev?.dueTimestamp >= cutoffMs);
			removed += array.length - kept.length;
			channel.events[sectionKey] = kept;
		}

		return removed;
	} catch {
		return 0;
	}
}

// Helper: delete ad-hoc posts for a channel and clear index
async function deleteAdhocPostsForChannel({ client, channelId }) {
	try {
		const records = await listChannelPostRecords(channelId);
		if (!records || records.length === 0) return 0;
		const channel = await client.channels.fetch(channelId);
		const deletions = records.map(async (r) => {
			try {
				try {
					untrack(r.messageId);
				} catch {}

				const message = await channel.messages.fetch(r.messageId);
				await message.delete();
			} catch {}
		});
		await Promise.allSettled(deletions);
		try {
			await deleteChannelPostRecords(channelId);
		} catch {}

		// As a fallback (e.g., when index is missing), also scan recent messages
		try {
			const recent = await channel.messages.fetch({ limit: 50 });
			const looksLikeAdhoc = (message) => {
				if (!Array.isArray(message?.components)) return false;
				for (const row of message.components) {
					if (!Array.isArray(row?.components)) continue;
					for (const comp of row.components) {
						if (
							comp?.customId &&
							String(comp.customId).startsWith("hw_add_sec_")
						) {
							return true;
						}
					}
				}

				return false;
			};

			const extra = recent.filter((m) => looksLikeAdhoc(m));
			const extraDeletions = [...extra.values()].map(async (m) => {
				try {
					try {
						untrack(m.id);
					} catch {}

					await m.delete();
				} catch {}
			});
			await Promise.allSettled(extraDeletions);
		} catch {}

		return records.length;
	} catch {
		return 0;
	}
}

// -------------- helpers (duplicated from type/send for now) --------------

const SECTION_TO_CLASSKEY = new Map([
	[1, "maggio 2/3"],
	[2, "maggio 3/4"],
	[3, "hua 5/6"],
	[4, "maggio 6/7"],
	[5, "chan 8/9"],
	[6, "hua 7/8"],
	[7, "chan 9/10"],
]);

// Reverse map for labeling (classKey -> section number)
const _CLASSKEY_TO_SECTION = new Map([
	["maggio 2/3", 1],
	["maggio 3/4", 2],
	["hua 5/6", 3],
	["maggio 6/7", 4],
	["chan 8/9", 5],
	["hua 7/8", 6],
	["chan 9/10", 7],
]);

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
	const utc = zonedTimeToUtc(zoned, ET);
	return { title, classKey, dueTimestamp: utc.getTime() };
}
