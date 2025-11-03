/* eslint-disable sort-imports */
import process from "node:process";
import axios from "axios";

const { EDGE_CONFIG_ID } = process.env;
const { EDGE_CONFIG_TOKEN } = process.env; // For reads (edge-config.vercel.com)
const { VERCEL_API_TOKEN } = process.env; // For writes (api.vercel.com)

const KEY = "homeworkTracker";

export async function loadPersistedRecords() {
	if (!EDGE_CONFIG_ID || !EDGE_CONFIG_TOKEN) return [];
	try {
		const url = `https://edge-config.vercel.com/${EDGE_CONFIG_ID}/item/${KEY}`;
		const response = await axios.get(url, {
			params: { token: EDGE_CONFIG_TOKEN },
			headers: { "Content-Type": "application/json" },
		});
		const value = response?.data ?? null;
		if (!value) return [];
		if (Array.isArray(value?.records)) return value.records;
		if (Array.isArray(value)) return value;
		return [];
	} catch {
		return [];
	}
}

export async function savePersistedRecords(records) {
	if (!EDGE_CONFIG_ID || !VERCEL_API_TOKEN) return false;
	try {
		const url = `https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`;
		const payload = {
			items: [
				{
					operation: "upsert",
					key: KEY,
					value: { version: 1, updatedAt: Date.now(), records },
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
