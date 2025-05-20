import process from "node:process";
// eslint-disable-next-line sort-imports
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";

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
client.on("messageCreate", (message) => {
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
	} else if (message.channelId === process.env.API_CHANNEL_ID) {
		// For messages between api and bot (api sends webhook, bot picks up message)
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
