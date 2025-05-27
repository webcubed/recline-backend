/* eslint-disable @stylistic/indent */
import { Buffer } from "node:buffer";
import { createServer } from "node:https";
import fs from "node:fs";
import process from "node:process";
// eslint-disable-next-line sort-imports
import { Client, GatewayIntentBits } from "discord.js";
import axios from "axios";
import dotenv from "dotenv";
import express from "express";
import ws from "ws";
// eslint-disable-next-line sort-imports
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
		console.log(
			`%cMessage from: %c${message.author.username} %cMessage: ${message.content}`,
			"color: #8aadf4",
			"color: #cad3f5",
			"color: #c6a0f6"
		);
		const newmsg = {
			timestamp: message.createdTimestamp,
			content: message.content,
			cleanContent: message.cleanContent,
			author: message.author.username,
		};
		for (const client of wsServer.clients) {
			if (client.readyState === WebSocket.OPEN) {
				client.send(JSON.stringify(newmsg));
			}
		}
	}
});

client.login(token);
/* -------------------------------- functions ------------------------------- */

async function fetchMessages(continueId = null) {
	const channel = client.channels.cache.get(process.env.CHANNEL_ID);
	const rawMessages = [];

	// Start fetching messages from the continueId if provided
	let message = continueId
		? await channel.messages.fetch(continueId)
		: await channel.messages
				.fetch({ limit: 1, force: true })
				.then((messagePage) =>
					messagePage.size === 1 ? messagePage.at(0) : null
				);
	let hasMore = true;
	let lastMessageId = null;
	rawMessages.push(message);
	while (hasMore && message) {
		// eslint-disable-next-line no-await-in-loop
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
		} else {
			hasMore = false;
		}
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
			timestamp: message?.createdTimestamp,
			content: message.content,
			cleanContent: message.cleanContent,
			author: message.author.username,
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
wsServer.on("connection", (socket) => {
	console.log("WebSocket client connected");
	socket.on("message", (message) => {
		console.log(`Received message: ${message}`);
	});
	socket.on("close", () => {
		console.log("WebSocket client disconnected");
	});
});
server.listen(3001, () => {
	console.log("WebSocket server listening on port 3001");
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((request, resource, next) => {
	resource.header("Access-Control-Allow-Origin", "https://webcubed.is-a.dev");
	resource.header(
		"Access-Control-Allow-Methods",
		"GET, POST, PUT, DELETE, OPTIONS"
	);
	resource.header(
		"Access-Control-Allow-Headers",
		"Content-Type, Authorization"
	);
	next();
});
/* -------------------------------- variables ------------------------------- */
const whitelistedEmails = new Set(JSON.parse(process.env.WHITELISTED_EMAILS));
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
	} catch (error) {
		console.error(error);
	}
}

app.get("/", (request, response) => {
	response.send("hi whats up");
});
app.get("/mappings", async (request, response) => {
	const storage = structuredClone(await getStorage());

	const mappings = Object.entries(storage.accounts).map(([account, data]) => ({
		account,
		name: data.name,
	}));

	response.json(mappings);
});
app.post("/genCode", async (request, response) => {
	const { account, name } = request.body;
	// Reject if account isn't whitelisted
	if (!whitelistedEmails.has(account)) {
		response.status(403).send("Account not whitelisted");
		return;
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

	const storage = await getStorage();
	storage.accounts[account] = {
		name,
		code,
	};
	editStorage("update", "storage", storage);

	response.json({ code, account });
});
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

app.post("/sendMessage", async (request, response) => {
	const { account, code, message } = request.body;
	const { name } = structuredClone(await getStorage()).accounts[account];
	if (code !== structuredClone(await getStorage()).accounts[account].code) {
		response.send("Invalid code");
		return;
	}

	try {
		await messageToDiscord(name, message);
		response.send("Message sent");
	} catch (error) {
		console.error(error);
		response.status(500).send("Error sending message");
	}
});

app.post("/fetchMessages", async (request, response) => {
	const { account, code, continueId } = request.body;
	// Verify code
	if (code !== structuredClone(await getStorage()).accounts[account].code) {
		response.send("Invalid code");
		return;
	}

	// Fetch messages
	const messages = await fetchMessages(continueId ?? null);
	response.send(messages);
});
app.get("/healthcheck", (request, response) => {
	response.send("im alive");
});
app.post("/mailToUser", async (request, response) => {
	const { code, account } = request.body;
	const storage = structuredClone(await getStorage());
	if (code !== storage.accounts[account].code) {
		response.status(403).send("Invalid code");
		return;
	}

	const user = Object.keys(storage.accounts).find((user) => user === account);
	if (!user) {
		response.status(404).send("User not found");
		return;
	}

	response.send({ username: storage.accounts[user].name });
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

app.post("/checkSession", async (request, response) => {
	// Warning: there is a loophole currently allowing user to set code in localstorage to skip mail check
	// The mail check ensures only one client at a time can have access
	const { account, code } = request.body;
	const storageCode = structuredClone(await getStorage()).accounts[account]
		.code;
	if (code === storageCode) {
		response.send("authorized :>");
	} else {
		response.send("Invalid code");
	}
});

app.post("/check", async (request, response) => {
	const { account, code } = request.body;

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
	const storage = await getStorage();
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
	.on("upgrade", (request, socket, head) => {
		wsServer.handleUpgrade(request, socket, head, (socket) => {
			wsServer.emit("connection", socket, request);
		});
	});
export default app;
