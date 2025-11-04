/* eslint-disable sort-imports */
import process from "node:process";
import axios from "axios";

const { EDGE_CONFIG_ID } = process.env;
const { EDGE_CONFIG_TOKEN } = process.env; // For reads
const { VERCEL_API_TOKEN } = process.env; // For writes

const KEY = "homeworkPostIndexV1";

// Shape:
// {
//   version: 1,
//   updatedAt: number,
//   posts: {
//     [messageId]: { channelId, messageId, classKey, format, events }
//   }
// }

export async function loadPostIndex() {
	if (!EDGE_CONFIG_ID || !EDGE_CONFIG_TOKEN)
		return { version: 1, updatedAt: 0, posts: {} };
	try {
		const url = `https://edge-config.vercel.com/${EDGE_CONFIG_ID}/item/${KEY}`;
		const response = await axios.get(url, {
			params: { token: EDGE_CONFIG_TOKEN },
			headers: { "Content-Type": "application/json" },
		});
		const value = response?.data ?? null;
		if (!value) return { version: 1, updatedAt: 0, posts: {} };
		if (value?.posts && typeof value.posts === "object") return value;
		return { version: 1, updatedAt: 0, posts: {} };
	} catch {
		return { version: 1, updatedAt: 0, posts: {} };
	}
}

export async function savePostIndex(index) {
	if (!EDGE_CONFIG_ID || !VERCEL_API_TOKEN) return false;
	try {
		const url = `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`;
		const payload = {
			items: [
				{
					operation: "upsert",
					key: KEY,
					value: { ...index, updatedAt: Date.now(), version: 1 },
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

export async function upsertPostRecord({
	messageId,
	channelId,
	classKey,
	format,
	events,
}) {
	const index = await loadPostIndex();
	index.posts ||= {};
	index.posts[messageId] = { messageId, channelId, classKey, format, events };
	await savePostIndex(index);
}

export async function getPostRecord(messageId) {
	const index = await loadPostIndex();
	return index.posts?.[messageId];
}
