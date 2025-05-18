import process from "node:process";
import dotenv from "dotenv"; // eslint-disable-line sort-imports
import express from "express";
import { parseString } from "xml2js";
import { XMLHttpRequest } from "xmlhttprequest"; // eslint-disable-line sort-imports

dotenv.config();
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
const whitelistedEmails = new Set(JSON.parse(process.env.WHITELISTED_EMAILS));
// Will get reset every time redeployed.
const storage = {
	accounts: {},
};

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

	storage.accounts[account] = {
		name,
		code,
	};
	response.json({ code, account });
});
app.post("/sendMessage", async (request, response) => {
	const { account, code, message } = request.body;
	const { name } = storage.accounts[account];
	if (code !== storage.accounts[account].code) {
		response.send("Invalid code");
		return;
	}
	// Do something cool with this eventually

	response.send("work in progress");
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
		xhr.addEventListener("readystatechange", function () {
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
	if (code === storage.accounts[account].code) {
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
	for (const entry of entries) {
		const title = entry.title[0];
		const summary = entry.summary[0];
		const issued = entry.issued[0];

		if (title !== 'Share request for "auth"') continue;

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
			parsedCode === storage.accounts[account]?.code
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
