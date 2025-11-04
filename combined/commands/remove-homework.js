/* eslint-disable sort-imports */
import { SlashCommandBuilder } from "discord.js";
import {
	allowedSectionsForChannel,
	hasMonitorRole,
	isChannelAllowed,
} from "./allowed-channels.js";
import {
	ensureChannel,
	loadEventsStore,
	saveEventsStore,
} from "./homework-events-store.js";

export const removeHomeworkCommand = new SlashCommandBuilder()
	.setName("removehomework")
	.setDescription("Remove stored homework by section and index or query")
	.addIntegerOption((opt) =>
		opt
			.setName("section")
			.setDescription("Section number (1-7)")
			.setMinValue(1)
			.setMaxValue(7)
			.setRequired(true)
	)
	.addIntegerOption((opt) =>
		opt
			.setName("index")
			.setDescription(
				"Index within this section's list (1-based); removes that single item"
			)
			.setMinValue(1)
			.setRequired(false)
	)
	.addStringOption((opt) =>
		opt
			.setName("query")
			.setDescription(
				"Case-insensitive substring of the title; removes all matches"
			)
			.setRequired(false)
	);

export async function handleRemoveHomework(interaction) {
	if (
		!interaction.isChatInputCommand() ||
		interaction.commandName !== "removehomework"
	)
		return;

	const channelId = interaction.channel.id;
	if (!isChannelAllowed(channelId)) {
		await interaction.reply({
			content: "This channel isn't configured for homework storage.",
			ephemeral: true,
		});
		return;
	}

	if (!hasMonitorRole(interaction.member)) {
		await interaction.reply({
			content: "You need the monitor role to modify stored homework.",
			ephemeral: true,
		});
		return;
	}

	const section = String(interaction.options.getInteger("section"));
	const indexOpt = interaction.options.getInteger("index");
	const queryOpt = interaction.options.getString("query");

	if (!indexOpt && !queryOpt) {
		await interaction.reply({
			content: "Provide either index or query to remove.",
			ephemeral: true,
		});
		return;
	}

	const store = await loadEventsStore();
	const allowedSections = allowedSectionsForChannel(channelId);
	const channel = ensureChannel(store, channelId, allowedSections);
	const list = channel.events?.[section] ?? [];
	if (list.length === 0) {
		await interaction.reply({
			content: `No events found for Section ${section}.`,
			ephemeral: true,
		});
		return;
	}

	let removed = 0;
	if (indexOpt) {
		const idx = indexOpt - 1;
		if (idx < 0 || idx >= list.length) {
			await interaction.reply({
				content: `Index out of range. There are ${list.length} events.`,
				ephemeral: true,
			});
			return;
		}

		const target = [...list]
			.sort((a, b) => a.dueTimestamp - b.dueTimestamp)
			.at(idx);
		channel.events[section] = list.filter(
			(item) =>
				!(
					item.title === target.title &&
					item.dueTimestamp === target.dueTimestamp &&
					item.classKey === target.classKey
				)
		);
		removed = list.length - channel.events[section].length;
	} else if (queryOpt) {
		const q = queryOpt.toLowerCase();
		channel.events[section] = list.filter(
			(item) => !item.title.toLowerCase().includes(q)
		);
		removed = list.length - channel.events[section].length;
	}

	await saveEventsStore(store);
	await interaction.reply({
		content: `Removed ${removed} item${removed === 1 ? "" : "s"} from Section ${section}.`,
		ephemeral: true,
	});
}
