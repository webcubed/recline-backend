import { renderImage } from "./homework-renderers.js";

// In-memory record of posted homework images to refresh daily.
// [{ channelId, messageId, events: [{title, classKey, dueTimestamp}], classKey }]
const tracked = new Map(); // Key: messageId, value: record

export async function trackImagePost({
	channelId,
	messageId,
	events,
	classKey,
}) {
	tracked.set(messageId, { channelId, messageId, events, classKey });
}

export function untrack(messageId) {
	tracked.delete(messageId);
}

export function listTracked() {
	return [...tracked.values()];
}

export async function refreshImagesDaily(client) {
	const entries = listTracked();
	const now = Date.now();
	const work = entries.map(async (record) => {
		const allDue = record.events.every((event) => event.dueTimestamp <= now);
		if (allDue) return;
		try {
			const channel = await client.channels.fetch(record.channelId);
			if (!channel) return;
			const message = await channel.messages.fetch(record.messageId);
			if (!message) return;
			const payload = await renderImage({
				events: record.events,
				headerClass: record.classKey,
			});
			await message.edit(payload);
		} catch (error) {
			const message = String(error?.message || "")
				.toLowerCase()
				.includes("unknown");
			if (message) untrack(record.messageId);
		}
	});
	await Promise.allSettled(work);
}
