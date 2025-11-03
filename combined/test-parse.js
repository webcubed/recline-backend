#!/usr/bin/env node
/* eslint-disable sort-imports */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Import only the needed functions by dynamic import to avoid circular runtime with discord.js
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modulePath = path.resolve(__dirname, "./commands/type-homework.js");
const mod = await import(modulePath);

const { default: _default, ...rest } = mod; // Tolerate default if set

// We need parseEventLine and SECTION mapping helpers; parseEventLine requires classKey
const parseEventLine = rest.parseEventLine ?? mod.parseEventLine;
// Provide a classKey based on a section number arg or default to chan 9/10 (section 7)

function classKeyForSection(sec) {
	const map = new Map([
		[1, "maggio 2/3"],
		[2, "maggio 3/4"],
		[3, "hua 5/6"],
		[4, "maggio 6/7"],
		[5, "chan 8/9"],
		[6, "hua 7/8"],
		[7, "chan 9/10"],
	]);
	return map.get(sec) ?? "chan 9/10";
}

function usage() {
	console.log("Usage:");
	console.log(
		"  node test-parse.js <section> '<title -|- Month D, YYYY -|- a|b [-|- HH:MM[:SS]]>'"
	);
	console.log("");
	console.log("Examples:");
	console.log(
		"  node test-parse.js 7 'bubble lab writeup -|- November 3, 2025 -|- b'"
	);
	console.log(
		"  node test-parse.js 7 'cells unit 3 test -|- November 10, 2025 -|- b -|- 08:00' "
	);
}

const args = process.argv.slice(2);
if (args.length < 2) {
	usage();
	process.exit(1);
}

const section = Number.parseInt(args[0], 10);
const line = args.slice(1).join(" ");
const classKey = classKeyForSection(section);

try {
	const result = parseEventLine(line, classKey);
	if (result.ok) {
		const ev = result.event;
		console.log("OK");
		console.log(JSON.stringify(ev, null, 2));
	} else {
		console.log("ERROR:", result.error);
	}
} catch (error) {
	console.error("Parse threw:", error?.message ?? String(error));
	process.exit(2);
}
