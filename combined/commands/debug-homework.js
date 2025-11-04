/* eslint-disable sort-imports */
import { SlashCommandBuilder } from "discord.js";
import { formatInTimeZone } from "date-fns-tz";
import {
	ensureChannel,
	listAllEvents,
	loadEventsStore,
	saveEventsStore,
} from "./homework-events-store.js";
import { hasMonitorRole, isChannelAllowed } from "./allowed-channels.js";
import { loadPostIndex } from "./post-index-store.js";
import { bumpDailyIfNeeded, postDailyForChannel } from "./daily-poster.js";

const ET = "America/New_York";

export const hwDebugCommand = new SlashCommandBuilder()
	.setName("hwdebug")
	.setDescription("Homework debug tools (monitor role only)")
	.addSubcommand((sub) =>
		sub.setName("events").setDescription("Show events summary for this channel")
	)
	.addSubcommand((sub) =>
		sub
			.setName("index")
			.setDescription("Show ad-hoc post index for this channel")
	)
	.addSubcommand((sub) =>
		sub
			.setName("last")
			.setDescription("Show last daily post id and whether it exists")
	)
	.addSubcommand((sub) =>
		sub
			.setName("bump")
			.setDescription("Force sticky bump (delete + repost daily)")
	)
	.addSubcommand((sub) =>
		sub
			.setName("post")
			.setDescription("Attempt to post the daily now (without bump trigger)")
	);

// eslint-disable-next-line complexity
export async function handleHwDebug(interaction) {
	if (
		!interaction.isChatInputCommand() ||
		interaction.commandName !== "hwdebug"
	)
		return;

	const sub = interaction.options.getSubcommand();
	const channelId = interaction.channel.id;

	if (!hasMonitorRole(interaction.member)) {
		await interaction.reply({
			content: "Monitor role required.",
			ephemeral: true,
		});
		return;
	}

	if (!isChannelAllowed(channelId)) {
		await interaction.reply({
			content: "This channel is not configured for homework.",
			ephemeral: true,
		});
		return;
	}

	await interaction.deferReply({ ephemeral: true });
	try {
		if (sub === "events") {
			const store = await loadEventsStore();
			const all = listAllEvents(store, channelId);
			const startOfToday = new Date(
				formatInTimeZone(new Date(), ET, "yyyy-MM-dd'T'00:00:00")
			);
			const today = all.filter(
				(event) => event.dueTimestamp >= startOfToday.getTime()
			);
			const byClass = {};
			for (const event of all)
				byClass[event.classKey] = (byClass[event.classKey] ?? 0) + 1;
			await interaction.editReply({
				content: [
					`channel: ${channelId}`,
					`allowed: ${store.channels?.[channelId]?.allowedSections?.join(", ") ?? "[]"}`,
					`lastPostId: ${store.channels?.[channelId]?.lastPostId ?? "(none)"}`,
					`lastPostDate: ${store.channels?.[channelId]?.lastPostDate ?? "(none)"}`,
					`counts: all=${all.length}, today=${today.length}`,
					`byClass: ${JSON.stringify(byClass)}`,
				].join("\n"),
			});
			return;
		}

		if (sub === "index") {
			const index = await loadPostIndex();
			const array = Object.values(index.posts || {}).filter(
				(p) => p.channelId === channelId
			);
			await interaction.editReply({ content: JSON.stringify(array, null, 2) });
			return;
		}

		if (sub === "last") {
			const store = await loadEventsStore();
			const last = store.channels?.[channelId]?.lastPostId;
			let exists = false;
			if (last) {
				try {
					const channel = await interaction.client.channels.fetch(channelId);
					await channel.messages.fetch(last);
					exists = true;
				} catch {}
			}

			await interaction.editReply({
				content: `lastPostId=${last ?? "(none)"} exists=${exists}`,
			});
			return;
		}

		if (sub === "bump") {
			const ok = await bumpDailyIfNeeded({
				client: interaction.client,
				channelId,
				authorIsBot: false,
			});
			await interaction.editReply({ content: `bumpDailyIfNeeded=${ok}` });
			return;
		}

		if (sub === "post") {
			const store = await loadEventsStore();
			ensureChannel(store, channelId);
			const sent = await postDailyForChannel({
				client: interaction.client,
				channelId,
				store,
			});
			if (sent) await saveEventsStore(store);
			await interaction.editReply({
				content: `postDailyForChannel=${Boolean(sent)}`,
			});
			return;
		}

		await interaction.editReply({ content: "Unknown subcommand" });
	} catch (error) {
		await interaction.editReply({
			content: `Error: ${error?.message ?? String(error)}`,
		});
	}
}
