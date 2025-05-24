import Buffer from "node:buffer";
import process from "node:process";
// eslint-disable-next-line sort-imports
import * as Ably from "ably";
import axios from "axios";
import dotenv from "dotenv";
import express from "express";
import { parseString } from "xml2js";
// eslint-disable-next-line sort-imports
import { XMLHttpRequest } from "xmlhttprequest";

/* ------------------------------ dotenv config ----------------------------- */
dotenv.config();
/* ----------------------------- express config ----------------------------- */
const app = express();
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
const ablyChannel = new Ably.Realtime({
	key: process.env.ABLY_API_KEY,
});
async function getStorage() {
	const options = {
		method: "GET",
		url: `https://edge-config.vercel.com/${process.env.EDGE_CONFIG_ID}/item/storage`,
		params: { token: process.env.EDGE_CONFIG_TOKEN },
		headers: {
			"Content-Type": "application/json",
		},
	};

	return axios
		.request(options)
		.then((response) => response.data)
		.catch((error) => {
			console.error(error);
			return null;
		});
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
	await axios.request(options).catch((error) => {
		console.error(error);
	});
}

async function fetchMessagesFromBot(continueId = null) {
	if (continueId) {
		try {
			const response = await axios.post(process.env.API_WEBHOOK, {
				content: `fetch messages from ${continueId}`,
			});
			return response.data;
		} catch (error) {
			return console.error(error);
		}
	} else {
		try {
			const response = await axios.post(process.env.API_WEBHOOK, {
				content: "fetch messages",
			});
			return response.data;
		} catch (error) {
			return console.error(error);
		}
	}
}

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
app.post("/sendMessage", async (request, response) => {
	const { account, code, message } = request.body;
	const { name } = await getStorage().accounts[account];
	if (code !== (await getStorage().accounts[account].code)) {
		response.send("Invalid code");
		return;
	}

	// Do something cool with this eventually
	// Use webhook
	response.send("work in progress");
});
app.post("/haveMessages", async (request, response) => {
	const { messages, code } = request.body;
	// Verify code
	if (code !== structuredClone(process.env.SECRET_CODE)) {
		response.send("Invalid code");
	}
	// This is where you send them to the client via ably pub/sub
});

app.post("/fetchMessages", async (request, response) => {
	const { account, code, continueId } = request.body;
	// Verify code
	if (code !== structuredClone(await getStorage()).accounts[account].code) {
		response.send("Invalid code");
		return;
	}

	// Fetch messages
	response.send(fetchMessagesFromBot(continueId ?? null));
});
app.post("/newMessage", async (request, response) => {
	// If someone sends a message from discord
	const { message, code, account } = request.body;
	const { name } = await getStorage().accounts[account];
});
app.post("/userToMail", async (request, response) => {
	const { code, username } = request.body;
	if (code !== process.env.SECRET_CODE) {
		response.status(403).send("Invalid code");
		return;
	}

	const storage = structuredClone(await getStorage());
	const account = Object.keys(storage.accounts).find(
		async (account) => storage.accounts[account].name === username
	);
	if (!account) {
		response.status(404).send("Account not found");
		return;
	}

	response.send({ account, code: storage.accounts[account].code });
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

app.listen(3000, () => {
	console.log("app listening on port 3000");
});

export default app;
