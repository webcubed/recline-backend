/* eslint-disable sort-imports */
import { Buffer } from "node:buffer";
import { createServer } from "node:https";
import fs from "node:fs";
import process from "node:process";
import { Client, GatewayIntentBits } from "discord.js";
import axios from "axios";
import dotenv from "dotenv";
import express from "express";
import ws from "ws";
import { mw } from "request-ip";
import { XMLHttpRequest } from "xmlhttprequest";
import { parseString } from "xml2js";

/* ------------------------------ dotenv config ----------------------------- */
dotenv.config();
/* --------------------------- set up discord bot --------------------------- */
const token = process.env.DISCORD_TOKEN;
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});
client.once("ready", () => {
	console.log("bot ready");
});
client.on("messageCreate", async (message) => {
	// This is when a message gets sent from discord; discord -> client
	if (message.channelId !== process.env.CHANNEL_ID) {
		return;
	}

	// Read message, gather ID, send to client
	if (message.channelId === process.env.CHANNEL_ID) {
		const storage = structuredClone(await getStorage());
		console.log(
			`%cMessage from: %c${message.author.username} %cMessage: ${message.content}`,
			"color: #8aadf4",
			"color: #cad3f5",
			"color: #c6a0f6"
		);
		const newmsg = {
			timestamp: message.createdTimestamp,
			editedTimestamp: message.editedTimestamp,
			content: message.content,
			cleanContent: message.cleanContent,
			embeds: message.embeds,
			attachments: message.attachments.map((attachment) => ({
				url: attachment.url,
				name: attachment.name,
				filename: attachment.filename,
				type: attachment.contentType,
				proxyURL: attachment.proxyURL,
				id: attachment.id,
			})),
			author: message.author.username,
			id: message.id,
			email:
				mappings.find((data) => data.discordId === message.author.id)
					?.account ||
				Object.keys(storage.accounts)[
					Object.values(storage.accounts).indexOf(
						Object.values(storage.accounts).find((data) =>
							data.names.includes(message.author.username)
						)
					)
				],
		};
		for (const client of wsServer.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify({ type: "message", data: newmsg }));
			}
		}
	}
});
client.on("messageDelete", async (message) => {
	if (message.channelId === process.env.CHANNEL_ID) {
		for (const client of wsServer.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify({ type: "delete", data: message.id }));
			}
		}
	}
});
client.on("messageUpdate", async (oldMessage, newMessage) => {
	const storage = structuredClone(await getStorage());
	if (oldMessage.channelId === process.env.CHANNEL_ID) {
		for (const client of wsServer.clients) {
			if (client.readyState === WebSocket.OPEN) {
				const mappedMessages = [newMessage].map((message) => {
					return {
						id: message.id,
						author: message.author.username,
						content: message.content,
						cleanContent: message.cleanContent,
						embeds: message.embeds,
						attachments: message.attachments.map((attachment) => ({
							url: attachment.url,
							name: attachment.name,
							filename: attachment.filename,
							type: attachment.contentType,
							proxyURL: attachment.proxyURL,
							id: attachment.id,
						})),
						timestamp: message.createdTimestamp,
						editedTimestamp: message.editedTimestamp,
						email:
							mappings.find((data) => data.discordId === message.author.id)
								?.account ||
							Object.keys(storage.accounts)[
								Object.values(storage.accounts).indexOf(
									Object.values(storage.accounts).find((data) =>
										data.names.includes(message.author.username)
									)
								)
							],
					};
				});
				client.send(
					JSON.stringify({
						type: "update",
						data: mappedMessages[0],
						id: oldMessage.id,
						editedTimestamp: newMessage.editedTimestamp,
					})
				);
			}
		}
	}
});
client.login(token);
/* -------------------------------- functions ------------------------------- */

async function fetchMessages(continueId = null) {
	const channel = client.channels.cache.get(process.env.CHANNEL_ID);
	const rawMessages = [];
	const storage = structuredClone(await getStorage());
	let message;
	if (continueId) {
		message = await channel.messages.fetch(continueId);
	} else {
		const messagePage = await channel.messages.fetch({
			limit: 1,
			force: true,
		});
		message = messagePage.size === 1 ? messagePage.at(0) : null;
		rawMessages.push(message);
	}

	let lastMessageId = null;
	const messagePage = await channel.messages.fetch({
		limit: 50,
		force: true,
		before: message.id,
	});
	for (const message_ of messagePage) {
		rawMessages.push(message_);
	}

	if (messagePage.size > 0) {
		message = messagePage.at(messagePage.size - 1);
		lastMessageId = message.id;
	}

	/* --------------------------------- parsing -------------------------------- */
	// In the messages array, each item will be another array.
	// In this 2nd array, the first item will be the message Id,
	// And the second item will be the message information
	// Including the timestamp, which we will use to sort these messages in order and
	// Potentially append a date to the message
	// We'll also get the content in the value "content" or "cleanContent"
	// Cleancontent has mentions with display names instead of ids

	// Create our own messages array
	const unSortedMessages = rawMessages.map((rawData) => {
		const message = Array.isArray(rawData) ? rawData[1] : rawData;

		return {
			timestamp: message.createdTimestamp,
			editedTimestamp: message.editedTimestamp,
			content: message.content,
			cleanContent: message.cleanContent,
			embeds: message.embeds,
			attachments: message.attachments.map((attachment) => ({
				url: attachment.url,
				name: attachment.name,
				filename: attachment.filename,
				type: attachment.contentType,
				proxyURL: attachment.proxyURL,
				id: attachment.id,
			})),
			author: message.author.username,
			id: message.id,
			email:
				mappings.find((data) => data.discordId === message.author.id)
					?.account ||
				Object.keys(storage.accounts)[
					Object.values(storage.accounts).indexOf(
						Object.values(storage.accounts).find((data) =>
							data.names.includes(message.author.username)
						)
					)
				],
		};
	});
	// Sort based on timestamp
	const messages = unSortedMessages.sort((a, b) => {
		const dateA = new Date(a.timestamp);
		const dateB = new Date(b.timestamp);
		return dateA.getTime() - dateB.getTime();
	});
	return { messages, continueId: lastMessageId };
}

async function fetchMessageInfo(id) {
	const channel = client.channels.cache.get(process.env.CHANNEL_ID);
	const rawmsg = await channel.messages.fetch(id);
	const storage = structuredClone(await getStorage());
	const mappedMessages = [rawmsg].map((rawData) => {
		const message = Array.isArray(rawData) ? rawData[1] : rawData;
		return {
			id: message.id,
			author: message.author.username,
			content: message.content,
			cleanContent: message.cleanContent,
			embeds: message.embeds,
			attachments: message.attachments.map((attachment) => ({
				url: attachment.url,
				name: attachment.name,
				filename: attachment.filename,
				type: attachment.contentType,
				proxyURL: attachment.proxyURL,
				id: attachment.id,
			})),
			timestamp: message.createdTimestamp,
			editedTimestamp: message.editedTimestamp,
			email:
				mappings.find((data) => data.discordId === message.author.id)
					?.account ||
				Object.keys(storage.accounts)[
					Object.values(storage.accounts).indexOf(
						Object.values(storage.accounts).find((data) =>
							data.names.includes(message.author.username)
						)
					)
				],
		};
	});
	return mappedMessages;
}

async function deleteMessage(id) {
	const channel = client.channels.cache.get(process.env.CHANNEL_ID);
	const message = await channel.messages.fetch(id);
	await message.delete();
	// Broadcast to people on the websocket that this message should be deleted

	for (const client of wsServer.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(JSON.stringify({ type: "delete", data: id }));
		}
	}
}
/* ----------------------------- express config ----------------------------- */

const app = express();
const server = createServer(
	{
		key: fs.readFileSync("./key.pem"),
		cert: fs.readFileSync("./cert.pem"),
	},
	app
);
const wsServer = new ws.Server({ server });
wsServer.on("connection", async (socket, request) => {
	// Authenticate
	const account = request.url.match(/\?email=(.*)&/)[1];
	const code = request.url.match(/&code=(.*)/)[1];
	const storage = structuredClone(await getStorage());
	// If account or code aren't given, return to prevent errors
	if (!account || !code) {
		socket.close();
		return;
	}

	if (code !== storage.accounts[account].code) {
		socket.close();
		return;
	}

	if (storage.accounts[account].secure !== true) {
		socket.close();
		return;
	}

	socket.id = account;
	console.log("WebSocket client connected");
	// Broadcast
	for (const client of wsServer.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(JSON.stringify({ type: "connect", data: socket.id }));
		}
	}

	socket.on("message", (message) => {
		console.log(`Received message: ${message}`);
	});
	socket.on("close", () => {
		if (socket.id) {
			console.log(socket.id + " disconnected");
			// Broadcast
			for (const client of wsServer.clients) {
				if (client.readyState === WebSocket.OPEN) {
					client.send(JSON.stringify({ type: "disconnect", data: socket.id }));
				}
			}
		} else {
			console.log("WebSocket client disconnected");
		}
	});
});
server.listen(3001, () => {
	console.log("WebSocket server listening on port 3001");
});
app.set("trust proxy", true);
app.use(mw());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((request, resource, next) => {
	resource.header("Access-Control-Allow-Origin", "https://webcubed.is-a.dev");
	resource.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	resource.header(
		"Access-Control-Allow-Headers",
		"Content-Type, account, code, name"
	);
	next();
});
/* -------------------------------- variables ------------------------------- */
const whitelistedEmails = new Set(JSON.parse(process.env.WHITELISTED_EMAILS));
const mappings = JSON.parse(process.env.MAPPINGS);
async function getStorage() {
	const options = {
		method: "GET",
		url: `https://edge-config.vercel.com/${process.env.EDGE_CONFIG_ID}/item/storage`,
		params: { token: process.env.EDGE_CONFIG_TOKEN },
		headers: {
			"Content-Type": "application/json",
		},
	};

	try {
		const response = await axios.request(options);
		return response.data;
	} catch (error) {
		return error;
	}
}

async function editStorage(operation, key, value) {
	// Operation can be "create", "update", "upsert", "delete"
	// Key is the name
	// Value is the value to be assigned to key
	// value = JSON.stringify(value);
	const options = {
		method: "PATCH",
		url: `https://api.vercel.com/v1/edge-config/${process.env.EDGE_CONFIG_ID}/items`,
		headers: {
			Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`,
			"Content-Type": "application/json",
		},
		data: {
			items: [
				{
					operation,
					key,
					value,
				},
			],
		},
	};
	try {
		await axios.request(options);
		return true;
	} catch (error) {
		console.error(error);
	}
}

async function modifyUser(account, key, value) {
	const storage = structuredClone(await getStorage());
	storage.accounts[account][key] = value;
	await editStorage("update", "storage", storage);
	return true;
}

async function messageToDiscord(username, message) {
	// Send message to recline channel using webhook for storage
	const webhookUrl = process.env.CHAT_WEBHOOK;
	const data = {
		content: message,
		username,
	};
	const options = {
		method: "POST",
		url: webhookUrl,
		headers: {
			"Content-Type": "application/json",
		},
		data: JSON.stringify(data),
	};
	try {
		const response = await axios.request(options);
		return response.data;
	} catch (error) {
		return error;
	}
}

const authorize = async (request) => {
	const account = request.get("account");
	const code = request.get("code");
	const storage = structuredClone(await getStorage());
	console.log(
		account +
			" with ip " +
			request.clientIp +
			" is trying to access " +
			request.url
	);
	if (code !== storage.accounts[account].code) {
		console.log(account + " had invalid code");
		return false;
	}

	if (storage.accounts[account].secure !== true) {
		console.log(account + " was not secure");
		return false;
	}

	return true;
};

app.get("/", (request, response) => {
	response.send("hi whats up");
});
app.get("/healthcheck", (request, response) => {
	response.send("im alive");
});
app.get("/mappings", async (request, response) => {
	const storage = structuredClone(await getStorage());
	if (!(await authorize(request))) {
		return response.status(403).send("Not authorized");
	}

	const mappings = Object.entries(storage.accounts).map(([account, data]) => ({
		account,
		name: data.name,
		names: data.names,
	}));

	response.json(mappings);
});
app.get("/genCode", async (request, response) => {
	const account = request.get("account");
	const name = request.get("name");
	const storage = structuredClone(await getStorage());

	// Reject if account isn't whitelisted
	if (!whitelistedEmails.has(account)) {
		response.status(403).json({ error: "Account not whitelisted" });
		return;
	}

	// Reject if name already exists
	// Don't reject if trying to replace same account
	for (const user of Object.keys(storage.accounts)) {
		if (storage.accounts[user].name === name && user !== account) {
			response.status(403).json({ error: "Name already exists" });
			return;
		}
	}

	let code = Array.from({ length: 18 })
		.map(() => {
			const charPool = [
				...Array.from({ length: 10 }, (_, i) => i + 48), // Numbers 0-9
				...Array.from({ length: 26 }, (_, i) => i + 65), // Uppercase A-Z
				...Array.from({ length: 26 }, (_, i) => i + 97), // Lowercase a-z
				33, // Exclamation mark
				64, // At sign
				35, // Number sign
				36, // Dollar sign
				37, // Percent sign
				94, // Caret
				38, // Ampersand
				42, // Asterisk
			];
			return String.fromCodePoint(
				charPool[Math.floor(Math.random() * charPool.length)]
			);
		})
		.join("");
	code = Buffer.from(code).toString("base64");

	storage.accounts[account] = {
		name,
		code,
		secure: false,
	};
	// If "names" array exists, push name to array, Else, create array and push name to array
	if (storage.accounts[account].names) {
		storage.accounts[account].names.push(name);
	} else {
		storage.accounts[account].names = [name];
	}

	editStorage("update", "storage", storage);
	console.log("Code generated for " + account + ": " + code);
	response.json({ code, account });
});
app.get("/online", async (request, response) => {
	if (!(await authorize(request))) {
		return response.status(403).send("Not authorized");
	}
	// Get all online users from the WebSocket server

	const onlineUsers = [];
	for (const client of wsServer.clients) {
		if (client.readyState === ws.OPEN) {
			onlineUsers.push(client.id);
		}
	}

	// Also gather online members on discord
	const guild = client.guilds.cache.get(process.env.GUILD_ID);
	if (guild) {
		const members = await guild.members.fetch({ withPresences: true });
		const onlineMembers = members.filter(
			(member) => member.presence?.status === "online"
		);
		for (const member of onlineMembers) {
			const account = mappings.find(
				(data) => data.discordId === member.id
			)?.account;
			if (account) {
				onlineUsers.push(account);
			}
		}
	}

	response.json(onlineUsers);
});
app.post("/sendMessage", async (request, response) => {
	const account = request.get("account");
	const { message } = request.body;
	const { name } = structuredClone(await getStorage()).accounts[account];
	if (!(await authorize(request))) {
		return response.status(403).send("Not authorized");
	}

	try {
		await messageToDiscord(name, message);
		console.log("sent message: " + message + " for " + account);
		response.send("Message sent");
	} catch (error) {
		console.error(error);
		response.status(500).send("Error sending message");
	}
});
app.post("/deleteMessage", async (request, response) => {
	const { id } = request.body;
	// Need authorization
	const account = request.get("account");
	const storage = structuredClone(await getStorage());
	if (!(await authorize(request))) {
		return response.status(403).send("Not authorized");
	}

	if (
		(await fetchMessageInfo(id).author) !== storage.accounts[account].name &&
		account !== JSON.parse(process.env.WHITELISTED_EMAILS)[24]
	) {
		response.send("Not authorized");
		return;
	}

	try {
		await deleteMessage(id);
		console.log("deleted message: " + id + " for " + account);
		response.send("Message deleted");
	} catch (error) {
		console.error(error);
		response.status(500).send("Error deleting message");
	}
});
app.get("/fetchMessages", async (request, response) => {
	const { continueId } = request.query;
	if (!(await authorize(request))) {
		return response.status(403).send("Not authorized");
	}

	const messages = await fetchMessages(continueId ?? null);
	response.send(messages);
});

async function fetchInbox() {
	const xhr = new XMLHttpRequest();
	xhr.withCredentials = true;

	xhr.open(
		"GET",
		"https://mail.google.com/mail/feed/atom/auth",
		true,
		process.env.EMAIL,
		process.env.PASSWORD
	);
	xhr.send();
	return new Promise((resolve, reject) => {
		xhr.addEventListener("readystatechange", () => {
			if (xhr.readyState === 4) {
				if (xhr.status === 200) {
					resolve(xhr.responseText);
				} else {
					reject(new Error("Failed to fetch inbox"));
				}
			}
		});
	});
}

app.get("/checkSession", async (request, response) => {
	if (!(await authorize(request))) {
		return response.status(403).send("Not authorized");
	}

	response.send("authorized :>");
});

app.get("/check", async (request, response) => {
	const account = request.get("account");
	const code = request.get("code");
	// Cross checks the mail code and account with the generated code
	const xmlData = await fetchInbox();
	let parsedData;
	parseString(xmlData, (error, result) => {
		if (error) {
			response.status(500).send("Error parsing XML");
			return;
		}

		parsedData = result;
	});

	const count = parsedData.feed.fullcount[0];
	console.log(`Count: ${count}`);
	const entries = parsedData.feed.entry;
	const storage = structuredClone(await getStorage());
	const accountCode = storage.accounts[account]?.code;

	for (const entry of entries) {
		const title = entry.title[0];
		const summary = entry.summary[0];
		const issued = entry.issued[0];

		if (title !== 'Share request for "auth"') {
			continue;
		}

		console.log(`Summary: ${summary}`);
		console.log(`Issued: ${issued}`);

		const matches = [
			...summary.matchAll(
				/Share a document\? (.+) \([\w.%+-]+@[a-zA-Z\d.-]+\.[a-zA-Z]{2,}\)/g
			),
		];
		const authorName = matches.length > 0 ? matches[0][1] : undefined;
		const mailMatches = [
			...summary.matchAll(/\(([\w.%+-]+@[a-zA-Z\d.-]+\.[a-zA-Z]{2,})\)/g),
		];
		const authorMail = mailMatches.length > 0 ? mailMatches[0][1] : undefined;
		const codeMatches = [
			...summary.matchAll(
				/is requesting access to the following document: (.+) auth Manage sharing/g
			),
		];
		const parsedCode = codeMatches.length > 0 ? codeMatches[0][1] : undefined;
		console.log(`Author: ${authorName}`);
		console.log(`Mail: ${authorMail}`);
		console.log(`Code: ${parsedCode}`);

		// If accounts match
		if (
			authorMail === account &&
			parsedCode === code &&
			parsedCode === accountCode
		) {
			console.log("matches nicely");
			// SET TO SECURE????
			await modifyUser(account, "secure", true);
			// Approval
			response.send("authorized :>");

			// This should only be used to load the dashboard.
			// Subsequent requests should also cross check the code.
			return;
		}
	}
});

app
	.listen(3000, () => {
		console.log("app listening on port 3000");
	})
	.on("upgrade", async (request, socket, head) => {
		wsServer.handleUpgrade(request, socket, head, (socket) => {
			wsServer.emit("connection", socket, request);
		});
	});
export default app;
