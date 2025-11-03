import { renderImage } from "./homework-renderers.js";

// In-memory record of posted homework images and adaptive refresh buckets.
// Record shape: { channelId, messageId, events: [{title, classKey, dueTimestamp}], classKey, bucket?: 'second'|'minute'|'hour' }
const tracked = new Map(); // Key: messageId, value: record

// Buckets for adaptive refresh cadence
const buckets = {
	second: new Set(),
	minute: new Set(),
	hour: new Set(),
};

function getGranularityForRecord(record, now = Date.now()) {
	// Consider only future events
	const upcoming = record.events.filter((event) => event.dueTimestamp > now);
	if (upcoming.length === 0) return null;

	// Use remaining time to decide cadence: seconds for <1m, minutes for <1h, else hours
	const minRemaining = Math.min(
		...upcoming.map((event) => event.dueTimestamp - now)
	);
	if (minRemaining <= 60 * 1000) return "second";
	if (minRemaining <= 60 * 60 * 1000) return "minute";
	return "hour";
}

function updateBucketMembership(record) {
	// Remove from all first
	buckets.second.delete(record.messageId);
	buckets.minute.delete(record.messageId);
	buckets.hour.delete(record.messageId);

	const granularity = getGranularityForRecord(record);
	record.bucket = granularity ?? undefined;
	if (!granularity) return; // All events due; no bucket
	buckets[granularity].add(record.messageId);
}

export async function trackImagePost({
	channelId,
	messageId,
	events,
	classKey,
}) {
	const record = { channelId, messageId, events, classKey };
	tracked.set(messageId, record);
	updateBucketMembership(record);
}

export function untrack(messageId) {
	tracked.delete(messageId);
	buckets.second.delete(messageId);
	buckets.minute.delete(messageId);
	buckets.hour.delete(messageId);
}

export function listTracked() {
	return [...tracked.values()];
}

export function getTrackedStatus(messageId) {
	const record = tracked.get(messageId);
	if (!record) return { tracked: false };
	return {
		tracked: true,
		bucket: record.bucket ?? null,
		channelId: record.channelId,
		messageId: record.messageId,
		eventsCount: record.events?.length ?? 0,
		allDue:
			record.events?.every((event) => event.dueTimestamp <= Date.now()) ?? null,
	};
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
			// Re-evaluate granularity after update
			updateBucketMembership(record);
		} catch (error) {
			const message = String(error?.message || "")
				.toLowerCase()
				.includes("unknown");
			if (message) untrack(record.messageId);
		}
	});
	await Promise.allSettled(work);
}

async function refreshBucket(client, type) {
	const ids = [...buckets[type].values()];
	const now = Date.now();
	const work = ids.map(async (messageId) => {
		const record = tracked.get(messageId);
		if (!record) {
			buckets[type].delete(messageId);
			return;
		}

		const allDue = record.events.every((event) => event.dueTimestamp <= now);

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
			// If everything is due now, untrack after pushing the final 'due' state.
			if (allDue) {
				untrack(messageId);
				return;
			}

			// Otherwise reassign to the appropriate bucket after this tick
			updateBucketMembership(record);
		} catch (error) {
			const isUnknown = String(error?.message || "")
				.toLowerCase()
				.includes("unknown");
			if (isUnknown) untrack(record.messageId);
		}
	});
	await Promise.allSettled(work);
}

// Start adaptive image updates: seconds/minutes/hours buckets
export function startAdaptiveImageUpdates(client) {
	// Seconds bucket: refresh every second
	setInterval(() => {
		// Promote items that just crossed into <1 minute from the minute bucket
		for (const messageId of buckets.minute.values()) {
			const record = tracked.get(messageId);
			if (!record) {
				buckets.minute.delete(messageId);
				continue;
			}

			const granularity = getGranularityForRecord(record);
			if (granularity === "second") {
				buckets.minute.delete(messageId);
				buckets.second.add(messageId);
				record.bucket = "second";
			}
		}

		refreshBucket(client, "second");
	}, 1000);

	// Minutes bucket: refresh every minute
	setInterval(() => {
		// Promote items that just crossed into <1 hour from the hour bucket
		for (const messageId of buckets.hour.values()) {
			const record = tracked.get(messageId);
			if (!record) {
				buckets.hour.delete(messageId);
				continue;
			}

			const granularity = getGranularityForRecord(record);
			if (granularity === "minute") {
				buckets.hour.delete(messageId);
				buckets.minute.add(messageId);
				record.bucket = "minute";
			}
		}

		refreshBucket(client, "minute");
	}, 60 * 1000);

	// Hours bucket: refresh every hour
	setInterval(
		() => {
			refreshBucket(client, "hour");
		},
		60 * 60 * 1000
	);
}
