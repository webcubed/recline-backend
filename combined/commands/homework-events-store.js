/* eslint-disable sort-imports */
import process from "node:process";
import axios from "axios";

const { EDGE_CONFIG_ID, EDGE_CONFIG_TOKEN, VERCEL_API_TOKEN } = process.env;
const KEY = "homeworkEventsV1";

// Data shape
// {
// 	version: 1,
// 	updatedAt: 1700000000000,
// 	channels: {
// 		[channelId]: {
// 			allowedSections: number[],
// 			// Legacy (single daily):
// 			lastPostId?: string,
// 			lastPostDate?: string, // yyyy-mm-dd in ET
// 			// New per-section tracking:
// 			lastPosts?: { [section: string]: { id: string, date: string } },
// 			events: { [sectionNumber: string]: Array<{ title:string, dueTimestamp:number, classKey:string }> }
// 		}
// 	}
// }

function emptyStore() {
	return { version: 1, updatedAt: Date.now(), channels: {} };
}

export async function loadEventsStore() {
	if (!EDGE_CONFIG_ID || !EDGE_CONFIG_TOKEN) return emptyStore();
	try {
		const url = `https://edge-config.vercel.com/${EDGE_CONFIG_ID}/item/${KEY}`;
		const response = await axios.get(url, {
			params: { token: EDGE_CONFIG_TOKEN },
			headers: { "Content-Type": "application/json" },
		});
		const value = response?.data;
		if (!value || typeof value !== "object") return emptyStore();
		return value;
	} catch {
		return emptyStore();
	}
}

export async function saveEventsStore(store) {
	if (!EDGE_CONFIG_ID || !VERCEL_API_TOKEN) return false;
	try {
		const url = `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`;
		const payload = {
			items: [
				{
					operation: "upsert",
					key: KEY,
					value: { ...store, updatedAt: Date.now() },
				},
			],
		};
		await axios.patch(url, payload, {
			headers: {
				Authorization: `Bearer ${VERCEL_API_TOKEN}`,
				"Content-Type": "application/json",
			},
		});
		return true;
	} catch {
		return false;
	}
}

export function ensureChannel(store, channelId, allowedSections = []) {
	store.channels ||= {};
	store.channels[channelId] ||= {
		allowedSections: [...allowedSections],
		events: {},
		lastPostId: undefined,
		lastPostDate: undefined,
		lastPosts: {},
	};
	return store.channels[channelId];
}

export function addEvents(store, channelId, section, events) {
	const channel = ensureChannel(store, channelId);
	channel.events[section] ||= [];
	for (const eventItem of events) {
		// Avoid exact duplicates by title+dueTimestamp
		const exists = channel.events[section].some(
			(item) =>
				item.title === eventItem.title &&
				item.dueTimestamp === eventItem.dueTimestamp
		);
		if (!exists) {
			channel.events[section].push({
				title: eventItem.title,
				dueTimestamp: eventItem.dueTimestamp,
				classKey: eventItem.classKey,
			});
		}
	}
}

export function removeEvents(store, channelId, section, predicate) {
	const channel = ensureChannel(store, channelId);
	const list = channel.events[section] || [];
	const kept = list.filter((eventItem, index) => !predicate(eventItem, index));
	const removed = list.length - kept.length;
	channel.events[section] = kept;
	return removed;
}

export function listAllEvents(store, channelId) {
	const channel = ensureChannel(store, channelId);
	const map = channel.events || {};
	const merged = [];
	for (const [section, array] of Object.entries(map)) {
		for (const eventItem of array) {
			merged.push({ ...eventItem, section: Number.parseInt(section, 10) });
		}
	}

	return merged;
}

export function setLastPost(store, channelId, messageId, dateYmd) {
	const channel = ensureChannel(store, channelId);
	channel.lastPostId = messageId;
	channel.lastPostDate = dateYmd;
}

export function setLastPostForSection(parameters) {
	const { store, channelId, section, messageId, dateYmd } = parameters;
	const channel = ensureChannel(store, channelId);
	channel.lastPosts ||= {};
	channel.lastPosts[String(section)] = { id: messageId, date: dateYmd };
}

export function getLastPostForSection({ store, channelId, section }) {
	const channel = ensureChannel(store, channelId);
	const entry = channel.lastPosts?.[String(section)];
	return entry ?? null;
}
