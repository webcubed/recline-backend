import process from "node:process";
// eslint-disable-next-line sort-imports
import { Client, GatewayIntentBits } from "discord.js";
import axios from "axios";
import dotenv from "dotenv";

const apiBaseUrl = "https://recline-backend.vercel.app";
/* ------------------------------ set up dotenv ----------------------------- */
dotenv.config();
/* --------------------------- set up discord bot --------------------------- */
const token = process.env.DISCORD_TOKEN;
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});
client.once("ready", () => {
	console.log("bot ready");
});
client.on("messageCreate", async (message) => {
	// This is when a message gets sent from discord; discord -> client
	if (message.author.bot || message.channelId !== process.env.CHANNEL_ID)
		return; // Ignore bot messages
	// Read message, gather ID, send to client
	if (message.channelId === process.env.CHANNEL_ID) {
		console.log(
			`%cMessage from: %c${message.author.username} %cMessage: ${message.content}`,
			"color: #8aadf4",
			"color: #cad3f5",
			"color: #c6a0f6"
		);
		const { data: mail } = await axios.post(`${apiBaseUrl}/userToMail`, {
			username: message.author.username,
			code: process.env.SECRET_CODE,
		});
		axios.post(`${apiBaseUrl}/newMessage`, {
			message,
			code: process.env.SECRET_CODE,
			account: mail,
		});
	} else if (message.channelId === process.env.API_CHANNEL_ID) {
		// For messages between api and bot (api sends webhook, bot picks up message)
		if (message.content === "fetch messages") {
			const { continueId } = await fetchMessages();
			return axios.post(`${apiBaseUrl}/fetchMessages`, { continueId });
		}

		if (message.content.includes("fetch messages from ")) {
			const { continueId } = message.content.split("fetch messages from ")[1];
			const { messages, newContinueId } = await fetchMessages(continueId);
			axios.post(`${apiBaseUrl}/fetchMessages`, { messages, newContinueId });
		}
	}
});

client.login(token);
/* -------------------------------- functions ------------------------------- */

async function fetchMessages(continueId = null) {
	const channel = client.channels.cache.get(process.env.CHANNEL_ID);
	const messages = [];

	// Start fetching messages from the continueId if provided
	let message = continueId
		? await channel.messages.fetch(continueId)
		: await channel.messages
				.fetch({ limit: 1 })
				.then((messagePage) =>
					messagePage.size === 1 ? messagePage.at(0) : null
				);

	let hasMore = true;
	let lastMessageId = null;
	while (hasMore && message) {
		// eslint-disable-next-line no-await-in-loop
		const messagePage = await channel.messages.fetch({
			limit: 50,
			before: message.id,
		});
		for (const message_ of messagePage) messages.push(message_);
		if (messagePage.size > 0) {
			message = messagePage.at(messagePage.size - 1);
			lastMessageId = message.id;
		} else {
			hasMore = false;
		}
	}

	return { messages, continueId: lastMessageId };
}
