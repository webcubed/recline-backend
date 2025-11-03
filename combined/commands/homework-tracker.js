import { formatInTimeZone, zonedTimeToUtc } from "date-fns-tz";
import { loadPersistedRecords, savePersistedRecords } from "./tracker-store.js";
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

// For hour-level cadence aligned to the due minute-of-hour, we maintain 60 minute slots.
const hourSlots = Array.from({ length: 60 }, () => new Set());

const NY_TZ = "America/New_York";

// Simple in-memory caches to avoid repeated fetches each tick
// Channel cache entries include an expiry for pruning; message cache already has a TTL.
const channelCache = new Map(); // ChannelId -> { channel, expiresAt }
const messageCache = new Map(); // `${channelId}:${messageId}` -> { message, expiresAt }
const MESSAGE_TTL_MS = 2 * 60 * 1000; // 2 minutes
const CHANNEL_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CHANNEL_PRUNE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Per-channel edit queues with staggering and simple rate-limit backoff
const channelQueues = new Map(); // ChannelId -> { queue: Task[], processing: boolean, cooldownUntil?: number }

// Cap how many 'second' bucket messages we enqueue per tick to avoid bursts
const SECOND_BUCKET_CAP_PER_TICK = 6;

// Base delays per bucket type to stagger edits; jitter will be added on top
const BASE_DELAY_BY_BUCKET = {
	second: 120, // Milliseconds
	minute: 220,
	hour: 350,
};

/**
 * Compute the display label for a timestamp using staged countdown:
 *  - > 60s: minutes/hours/days as usual
 *  - 60..31s: "in 1 min"
 *  - 30..16s: "in 30 sec"
 *  - 15..11s: "in 15 sec"
 *  - 10..1s: "in {s} sec"
 *  - <=0: "due"
 */
function stagedRelativeLabel(ts, now) {
	const diff = ts - now;
	if (diff <= 0) return "due";
	const secs = Math.ceil(diff / 1000);
	if (secs > 60) {
		const mins = Math.round(diff / 60_000);
		if (mins < 60) return `in ${mins} min`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return `in ${hrs} hr${hrs === 1 ? "" : "s"}`;
		const days = Math.round(hrs / 24);
		return `in ${days} day${days === 1 ? "" : "s"}`;
	}

	if (secs > 30) return "in 1 min";
	if (secs > 15) return "in 30 sec";
	if (secs > 10) return "in 15 sec";
	return `in ${secs} sec`;
}

// Build a lightweight signature to know when a rendered payload would actually change
function computeRecordSignature(record, now) {
	const parts = [...record.events]
		.sort((a, b) => a.dueTimestamp - b.dueTimestamp)
		.map((event) => stagedRelativeLabel(event.dueTimestamp, now));
	// Include bucket as well to avoid edge cases where membership changes but labels don't
	parts.push(record.bucket || "");
	return parts.join("|");
}

async function getCachedChannel(client, channelId) {
	const now = Date.now();
	const cached = channelCache.get(channelId);
	if (cached) {
		if (cached.expiresAt > now) return cached.channel;
		channelCache.delete(channelId);
	}

	let channel = null;
	try {
		channel = await client.channels.fetch(channelId);
	} catch {}

	if (channel)
		channelCache.set(channelId, {
			channel,
			expiresAt: now + CHANNEL_TTL_MS,
		});
	return channel;
}

function pruneChannelCache() {
	const now = Date.now();
	for (const [id, entry] of channelCache.entries()) {
		if (!entry || entry.expiresAt <= now) channelCache.delete(id);
	}
}

async function getCachedMessage(client, channelId, messageId) {
	const key = `${channelId}:${messageId}`;
	const cached = messageCache.get(key);
	const now = Date.now();
	if (cached && cached.expiresAt > now) return cached.message;
	const channel = await getCachedChannel(client, channelId);
	if (!channel) return null;
	let message = null;
	try {
		message = await channel.messages.fetch(messageId);
	} catch {}

	if (message) {
		messageCache.set(key, { message, expiresAt: now + MESSAGE_TTL_MS });
	} else {
		messageCache.delete(key);
	}

	return message;
}

// Task execution for a single message edit within its channel queue
async function runTask(client, task) {
	const { record } = task;
	const now = Date.now();

	// Dedupe: if signature hasn't changed, skip heavy render/edit
	const sig = computeRecordSignature(record, now);
	if (record.lastSignature === sig) {
		// Still update bucket membership periodically
		updateBucketMembership(record);
		return;
	}

	const allDue = record.events.every((event) => event.dueTimestamp <= now);
	try {
		const message = await getCachedMessage(
			client,
			record.channelId,
			record.messageId
		);
		if (!message) {
			untrack(record.messageId);
			return;
		}

		const payload = await renderImage({
			events: record.events,
			headerClass: record.classKey,
		});
		await message.edit(payload);
		record.lastSignature = sig;

		if (allDue) {
			// Final 'due' state pushed; untrack afterwards
			untrack(record.messageId);
			return;
		}

		updateBucketMembership(record);
	} catch (error) {
		const text = String(error?.message || "").toLowerCase();
		if (text.includes("unknown")) {
			untrack(record.messageId);
			return;
		}

		// Simple rate-limit backoff: if 429 or rate limited, pause this channel queue
		if (
			text.includes("rate limit") ||
			text.includes("rate-limited") ||
			error?.status === 429
		) {
			const cq = channelQueues.get(record.channelId);
			if (cq) cq.cooldownUntil = Date.now() + 1500; // 1.5s backoff
		}
	}
}

function getOrCreateChannelQueue(channelId) {
	let cq = channelQueues.get(channelId);
	if (!cq) {
		cq = { queue: [], processing: false, cooldownUntil: 0 };
		channelQueues.set(channelId, cq);
	}

	return cq;
}

function enqueueEdit(client, record, type) {
	const cq = getOrCreateChannelQueue(record.channelId);
	cq.queue.push({ record, type, enqueuedAt: Date.now() });
	if (!cq.processing) processChannelQueue(client, record.channelId);
}

async function processChannelQueue(client, channelId) {
	const cq = getOrCreateChannelQueue(channelId);
	if (cq.processing) return;
	cq.processing = true;
	try {
		while (cq.queue.length > 0) {
			const now = Date.now();
			if (cq.cooldownUntil && now < cq.cooldownUntil) {
				// Pause processing until cooldown ends
				// eslint-disable-next-line no-await-in-loop
				await new Promise((resolve) => {
					setTimeout(resolve, cq.cooldownUntil - now);
				});
			}

			const task = cq.queue.shift();
			// Stagger spacing with small jitter to avoid bursts
			const base = BASE_DELAY_BY_BUCKET[task.type] ?? 200;
			const jitter = Math.floor(Math.random() * 60); // 0-59ms
			// eslint-disable-next-line no-await-in-loop
			await runTask(client, task);
			// eslint-disable-next-line no-await-in-loop
			await new Promise((resolve) => {
				setTimeout(resolve, base + jitter);
			});
		}
	} finally {
		cq.processing = false;
	}
}

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

	// Also remove from previous hour slot if any
	if (typeof record.hourSlot === "number") {
		hourSlots[record.hourSlot]?.delete(record.messageId);
		record.hourSlot = undefined;
	}

	const granularity = getGranularityForRecord(record);
	record.bucket = granularity ?? undefined;
	if (!granularity) return; // All events due; no bucket
	buckets[granularity].add(record.messageId);

	// If on hour cadence, assign a minute-of-hour slot based on the next upcoming event (NY time)
	if (granularity === "hour") {
		const now = Date.now();
		const upcoming = record.events
			.filter((event) => event.dueTimestamp > now)
			.sort((a, b) => a.dueTimestamp - b.dueTimestamp);
		const nextTs = upcoming[0]?.dueTimestamp;
		if (nextTs) {
			const minuteString = formatInTimeZone(new Date(nextTs), NY_TZ, "m");
			const minute = Number.parseInt(minuteString, 10) || 0;
			record.hourSlot = minute;
			hourSlots[minute].add(record.messageId);
		}
	}
}

export async function trackImagePost({
	channelId,
	messageId,
	events,
	classKey,
}) {
	const record = {
		channelId,
		messageId,
		events,
		classKey,
		lastSignature: undefined,
	};
	tracked.set(messageId, record);
	updateBucketMembership(record);
	schedulePersist();
}

export function untrack(messageId) {
	tracked.delete(messageId);
	buckets.second.delete(messageId);
	buckets.minute.delete(messageId);
	buckets.hour.delete(messageId);
	schedulePersist();
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
		// Use queue so we benefit from caching & dedupe
		enqueueEdit(client, record, record.bucket || "minute");
	});
	await Promise.allSettled(work);
}

// Maintain round-robin cursors for fairness when capping per tick
const bucketCursors = { second: 0, minute: 0, hour: 0 };

function processBucket(client, type) {
	const ids = [...buckets[type].values()];
	if (ids.length === 0) return;
	const cap = type === "second" ? SECOND_BUCKET_CAP_PER_TICK : ids.length;
	// Round-robin selection starting at cursor
	const cursor = bucketCursors[type] || 0;
	const selected = [];
	for (let i = 0; i < Math.min(cap, ids.length); i++) {
		selected.push(ids[(cursor + i) % ids.length]);
	}

	bucketCursors[type] = (cursor + selected.length) % ids.length;
	for (const messageId of selected) {
		const record = tracked.get(messageId);
		if (!record) {
			buckets[type].delete(messageId);
			continue;
		}
		// Enqueue edit task; queue handles dedupe and staggering

		enqueueEdit(client, record, type);
	}
}

function processHourSlot(client, minute) {
	const ids = [...hourSlots[minute].values()];
	if (ids.length === 0) return;
	for (const messageId of ids) {
		const record = tracked.get(messageId);
		if (!record) {
			hourSlots[minute].delete(messageId);
			continue;
		}

		if (record.bucket !== "hour") {
			hourSlots[minute].delete(messageId);
			continue;
		}

		enqueueEdit(client, record, "hour");
	}
}

function scheduleAlignedInterval(callback, periodMs) {
	const now = Date.now();
	const delay = periodMs - (now % periodMs);
	setTimeout(() => {
		callback();
		setInterval(callback, periodMs);
	}, delay);
}

function scheduleMidnightET(callback) {
	const now = new Date();
	const yyyy = formatInTimeZone(now, NY_TZ, "yyyy");
	const MM = formatInTimeZone(now, NY_TZ, "MM");
	const dd = formatInTimeZone(now, NY_TZ, "dd");
	const midnightTodayUtc = zonedTimeToUtc(
		`${yyyy}-${MM}-${dd} 00:00:00`,
		NY_TZ
	).getTime();
	const nextMidnightUtc = midnightTodayUtc + 24 * 60 * 60 * 1000;
	const delay = Math.max(1, nextMidnightUtc - Date.now());
	setTimeout(() => {
		callback();
		// Reschedule for the following midnight, re-evaluated to handle DST
		scheduleMidnightET(callback);
	}, delay);
}

// Start adaptive image updates: seconds/minutes/hours buckets
export function startAdaptiveImageUpdates(client) {
	// Load persisted tracked records exactly once on process start
	if (!startAdaptiveImageUpdates._restored) {
		startAdaptiveImageUpdates._restored = true;
		(async () => {
			try {
				await restorePersisted(client);
			} catch {}
		})();
	}

	// Start periodic channel-cache pruning only once.
	if (!startAdaptiveImageUpdates._channelPruneTimerStarted) {
		setInterval(pruneChannelCache, CHANNEL_PRUNE_INTERVAL_MS);
		startAdaptiveImageUpdates._channelPruneTimerStarted = true;
	}

	// Daily refresh at New York midnight
	if (!startAdaptiveImageUpdates._midnightRefreshStarted) {
		scheduleMidnightET(() => refreshImagesDaily(client));
		startAdaptiveImageUpdates._midnightRefreshStarted = true;
	}

	// Seconds bucket: refresh aligned to wall second
	scheduleAlignedInterval(() => {
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

		processBucket(client, "second");
	}, 1000);

	// Minutes bucket: refresh aligned to 00 seconds each minute
	scheduleAlignedInterval(() => {
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

		processBucket(client, "minute");
		// Process hour-level messages only for the current minute-of-hour
		const currentMinute = new Date().getMinutes();
		processHourSlot(client, currentMinute);
	}, 60 * 1000);
}

// Persistence helpers -------------------------------------------------------
let persistTimer;
function schedulePersist() {
	clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		const records = [...tracked.values()].map((r) => ({
			channelId: r.channelId,
			messageId: r.messageId,
			events: r.events,
			classKey: r.classKey,
		}));
		savePersistedRecords(records);
	}, 500);
}

async function restorePersisted(client) {
	const records = await loadPersistedRecords();
	if (!Array.isArray(records) || records.length === 0) return;

	const tasks = records.map(async (rec) => {
		if (!rec?.channelId || !rec?.messageId || !Array.isArray(rec?.events)) {
			return;
		}

		try {
			const channel = await client.channels.fetch(rec.channelId);
			if (!channel) return;
			const message = await channel.messages.fetch(rec.messageId);
			if (!message) return;
		} catch {
			return; // Skip missing
		}

		const record = {
			channelId: rec.channelId,
			messageId: rec.messageId,
			events: rec.events,
			classKey: rec.classKey,
			lastSignature: undefined,
		};
		tracked.set(rec.messageId, record);
		updateBucketMembership(record);
		// Enqueue one edit to catch up state (ensures 'due' is pushed if downtime crossed boundary)
		enqueueEdit(client, record, record.bucket || "minute");
	});

	await Promise.allSettled(tasks);
}
