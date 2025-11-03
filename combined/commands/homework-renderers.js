/* eslint-disable sort-imports */
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
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
		if (diff <= 0) return "due";
		const secs = Math.ceil(diff / 1000);
		if (secs < 60) return `in ${secs} sec`;
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
		// Register Lexend font with renderer only. No system fallbacks.
		const lexendPath = getLexendTtfPath();
		const hasLexend = lexendPath && fs.existsSync(lexendPath);
		if (!hasLexend) {
			// Don't attempt PNG if the required font isn't available; return SVG instead.
			throw new Error("Lexend TTF not available for PNG rendering");
		}

		const resvg = new Resvg(svg, {
			fitTo: { mode: "width", value: width },
			font: {
				loadSystemFonts: false,
				fontFiles: [lexendPath],
				defaultFontFamily: "Lexend",
				sansSerifFamily: "Lexend",
			},
		});
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

// Cache for embedded font CSS
let cachedLexendCss;

async function getEmbeddedLexendCss() {
	if (cachedLexendCss) return cachedLexendCss;
	try {
		const ttfPath = getLexendTtfPath();

		if (!ttfPath || !fs.existsSync(ttfPath)) {
			cachedLexendCss = "";
			return cachedLexendCss;
		}

		const ttf = fs.readFileSync(ttfPath);
		const b64 = Buffer.from(ttf).toString("base64");
		// Variable TTF supports a weight range; set broad range to allow bold header
		cachedLexendCss = `@font-face{font-family:'Lexend';src:url(data:font/ttf;base64,${b64}) format('truetype');font-weight:100 900;font-style:normal;font-display:swap;}`;
		return cachedLexendCss;
	} catch {
		cachedLexendCss = "";
		return cachedLexendCss;
	}
}

// Resolve the path to the bundled Lexend variable TTF or env override
function getLexendTtfPath() {
	const envPath = process.env.LEXEND_TTF_PATH;
	let ttfPath = envPath;
	if (!ttfPath) {
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = path.dirname(__filename);
		ttfPath = path.resolve(__dirname, "../fonts/lexend/Lexend[HEXP,wght].ttf");
	}

	return ttfPath;
}
