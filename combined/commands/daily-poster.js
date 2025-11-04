/* eslint-disable sort-imports */
import { formatInTimeZone, utcToZonedTime } from "date-fns-tz";
import { renderEmbed, renderImage, renderText } from "./homework-renderers.js";
import {
	ensureChannel,
	listAllEvents,
	loadEventsStore,
	saveEventsStore,
	setLastPost,
} from "./homework-events-store.js";
import { allowedSectionsForChannel } from "./allowed-channels.js";

const ET = "America/New_York";

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
				// Schedule next run in 24h from this ET time
				scheduleNext();
			}
		}, delay);
	};

	scheduleNext();
}

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

export async function postDailyForChannel({ client, channelId, store }) {
	const channel = await client.channels.fetch(channelId);
	if (!channel?.isTextBased?.()) return null;

	const allowed = allowedSectionsForChannel(channelId);
	ensureChannel(store, channelId, allowed);
	const all = listAllEvents(store, channelId);
	const todayYmd = formatInTimeZone(new Date(), ET, "yyyy-MM-dd");
	const startOfToday = new Date(
		formatInTimeZone(new Date(), ET, "yyyy-MM-dd'T'00:00:00")
	);
	const endOfToday = new Date(
		formatInTimeZone(new Date(), ET, "yyyy-MM-dd'T'23:59:59")
	);
	const startMs = startOfToday.getTime();
	const _endMs = endOfToday.getTime();

	// Keep only upcoming and due-today (mark past due). Drop everything strictly before today
	const filtered = all.filter((event) => event.dueTimestamp >= startMs);
	if (filtered.length === 0) return null;

	const header = `Daily Homework — ${todayYmd}`;
	const payload = await renderForDaily({
		events: filtered,
		headerClass: header,
	});
	let sent;
	try {
		sent = await channel.send(payload);
		setLastPost(store, channelId, sent.id, todayYmd);
		return sent;
	} catch {
		return null;
	}
}

async function renderForDaily({ events, headerClass }) {
	// Default to image; embed fallback if image throws; final fallback to text
	try {
		return await renderImage({ events, headerClass });
	} catch {}

	try {
		return renderEmbed({ events, headerClass });
	} catch {}

	return { content: renderText({ events, headerClass }) };
}

export async function bumpDailyIfNeeded({
	client,
	channelId,
	authorIsBot = false,
}) {
	if (authorIsBot) return;
	const store = await loadEventsStore();
	const channelData = store.channels?.[channelId];
	if (!channelData?.lastPostId) return;
	try {
		const channel = await client.channels.fetch(channelId);
		const message = await channel.messages.fetch(channelData.lastPostId);
		await message.delete();
	} catch {}

	await postDailyForChannel({ client, channelId, store });
	await saveEventsStore(store);
}
