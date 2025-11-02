/* eslint-disable sort-imports */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import process from "node:process";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import axios from "axios";
import { formatInTimeZone } from "date-fns-tz";
import { macchiato } from "./theme.js";

export function renderText({ events, headerClass }) {
	const resolvedClass = headerClass || events[0]?.classKey || "Class";
	const header = `# Homework — ${resolvedClass}`;
	const lines = events
		.sort((a, b) => a.dueTimestamp - b.dueTimestamp)
		.map(
			(event) =>
				`• ${event.title} — <t:${Math.floor(event.dueTimestamp / 1000)}:R>`
		);
	return [header, ...lines].join("\n");
}

export function renderEmbed({ events, headerClass }) {
	const resolvedClass = headerClass || events[0]?.classKey || "Class";
	const title = `Homework — ${resolvedClass}`;
	const embed = new EmbedBuilder()
		.setTitle(title)
		.setColor(Number.parseInt(macchiato.blue.replace("#", ""), 16))
		.setDescription("Upcoming assignments")
		.setTimestamp(new Date());

	for (const event of events.sort((a, b) => a.dueTimestamp - b.dueTimestamp)) {
		embed.addFields({
			name: `${event.title}`,
			value: `Due: <t:${Math.floor(event.dueTimestamp / 1000)}:R>`,
		});
	}

	return { embeds: [embed] };
}

// SVG generator
export async function renderImage({ events, headerClass }) {
	// Embed Lexend as WOFF2 via data URL so resvg or other renderers don't need network/fallbacks.
	const fontFaceCss = await getEmbeddedLexendCss();
	const baseTextCss = "text, tspan { font-family: 'Lexend'; }";
	const rel = (ts) => {
		const diff = ts - Date.now();
		const future = diff >= 0;
		if (!future) return "due";
		const mins = Math.round(diff / 60_000);
		if (mins < 60) return `in ${mins} min`;
		const hrs = Math.round(mins / 60);
		if (hrs < 24) return `in ${hrs} hr${hrs === 1 ? "" : "s"}`;
		const days = Math.round(hrs / 24);
		return `in ${days} day${days === 1 ? "" : "s"}`;
	};

	const rowHeight = 84;
	const titleY = 44;
	const marginUnderTitle = 56;
	const startY = titleY + marginUnderTitle;

	const items = events
		.sort((a, b) => a.dueTimestamp - b.dueTimestamp)
		.map(
			(event, index) => `
		<g transform="translate(24, ${startY + index * rowHeight})">
			<rect x="0" y="-32" rx="10" ry="10" width="760" height="64" fill="${macchiato.surface0}"/>
			<text x="24" y="0" dominant-baseline="middle" font-family="Lexend" font-size="18" fill="${macchiato.subtext0}">${
				event.title
			}</text>
			<text x="740" y="-8" dominant-baseline="middle" text-anchor="end" font-family="Lexend" font-size="16" fill="${macchiato.blue}"><tspan>${formatInTimeZone(
				new Date(event.dueTimestamp),
				"America/New_York",
				"MM/dd/yyyy"
			)}</tspan></text>
			<text x="740" y="12" dominant-baseline="middle" text-anchor="end" font-family="Lexend" font-size="14" fill="${macchiato.subtext1}"><tspan>${rel(
				event.dueTimestamp
			)}</tspan></text>
		</g>`
		)
		.join("");

	const width = 808;
	const height = startY + events.length * rowHeight + 24;
	const resolvedClass = headerClass || events[0]?.classKey || "Class";
	const headerText = `Homework — ${resolvedClass}`;
	const svg = `<?xml version="1.0" encoding="UTF-8"?>
	<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
		<defs>
			<style type="text/css"><![CDATA[
				${fontFaceCss}
				${baseTextCss}
			]]></style>
		</defs>
		<rect width="100%" height="100%" fill="${macchiato.base}"/>
		<text x="24" y="${titleY}" font-family="Lexend" font-size="30" font-weight="800" fill="${macchiato.lavender}">${headerText}</text>
		${items}
	</svg>`;

	// Try png otherwise just do svg
	try {
		const { Resvg } = await import("@resvg/resvg-js");
		const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
		const pngData = resvg.render();
		const pngBuffer = pngData.asPng();
		const attachment = new AttachmentBuilder(pngBuffer, {
			name: "homework.png",
		});
		return { files: [attachment] };
	} catch {
		const attachment = new AttachmentBuilder(Buffer.from(svg), {
			name: "homework.svg",
		});
		return { files: [attachment] };
	}
}

// Cache for embedded font
let cachedLexendData;
let cachedLexendCss;

async function getEmbeddedLexendCss() {
	if (cachedLexendCss) return cachedLexendCss;
	try {
		// Prefer local file if provided to avoid network dependency
		const localPath = process.env.LEXEND_WOFF2_PATH;
		if (localPath && fs.existsSync(localPath)) {
			const data = fs.readFileSync(localPath);
			cachedLexendData = Buffer.from(data).toString("base64");
			cachedLexendCss = `@font-face{font-family:'Lexend';src:url(data:font/woff2;base64,${cachedLexendData}) format('woff2');font-weight:400 800;font-style:normal;font-display:swap;}`;
			return cachedLexendCss;
		}

		// Fetch Google Fonts CSS and then the first WOFF2 URL
		const cssUrl =
			"https://fonts.googleapis.com/css2?family=Lexend:wght@400;700;800&display=swap";
		const cssResp = await axios.get(cssUrl, { responseType: "text" });
		const match = cssResp.data.match(/url\((https:[^)]+\.woff2)\)/u);
		if (!match) throw new Error("Could not find Lexend woff2 URL");
		const woff2Url = match[1];
		const binResp = await axios.get(woff2Url, {
			responseType: "arraybuffer",
		});
		cachedLexendData = Buffer.from(binResp.data).toString("base64");
		cachedLexendCss = `@font-face{font-family:'Lexend';src:url(data:font/woff2;base64,${cachedLexendData}) format('woff2');font-weight:400 800;font-style:normal;font-display:swap;}`;
		return cachedLexendCss;
	} catch {
		// If fetching fails, still set the family so rendering continues (will use system default if not found)
		cachedLexendCss = "";
		return cachedLexendCss;
	}
}
