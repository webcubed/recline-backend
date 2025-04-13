import process from "node:process";
import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import { parseString } from "xml2js";

dotenv.config();
const app = express();
async function fetchInbox() {
	const response = await axios.request(JSON.parse(process.env.REQUEST_OPTIONS));
	return response.data;
}

app.get("/auth", async (request, response) => {
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
		const code = codeMatches.length > 0 ? codeMatches[0][1] : undefined;
		console.log(`Author: ${authorName}`);
		console.log(`Mail: ${authorMail}`);
		console.log(`Code: ${code}`);
	}

	response.send(parsedData);
});

app.listen(3000, () => {
	console.log("Example app listening on port 3000!");
});

export default app;
