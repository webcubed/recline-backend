/* eslint-disable sort-imports */
import process from "node:process";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();

const PORT = Number.parseInt(process.env.INVITE_PORT ?? "3005", 10);
const { CLIENT_ID, INVITE_REDIRECT_BASE } = process.env;
const REDIRECT_BASE = INVITE_REDIRECT_BASE ?? `http://localhost:${PORT}`;

// Permission bits (BigInt to avoid precision issues)
const PERMS = {
	VIEW_CHANNEL: 1024n,
	SEND_MESSAGES: 2048n,
	MANAGE_MESSAGES: 8192n,
	EMBED_LINKS: 16_384n,
	ATTACH_FILES: 32_768n,
	READ_MESSAGE_HISTORY: 65_536n,
	USE_APPLICATION_COMMANDS: 2_147_483_648n,
};

function sumPermissions(bits) {
	let acc = 0n;
	for (const b of bits) acc += b;
	return acc.toString();
}

// Minimal as requested: Manage Messages + Use Application Commands
const minimalPerms = sumPermissions([
	PERMS.MANAGE_MESSAGES,
	PERMS.USE_APPLICATION_COMMANDS,
]);

const recommendedPerms = sumPermissions([
	PERMS.VIEW_CHANNEL,
	PERMS.SEND_MESSAGES,
	PERMS.MANAGE_MESSAGES,
	PERMS.EMBED_LINKS,
	PERMS.ATTACH_FILES,
	PERMS.READ_MESSAGE_HISTORY,
	PERMS.USE_APPLICATION_COMMANDS,
]);

function buildAuthUrl({ permissions, redirectUri }) {
	const base = "https://discord.com/api/oauth2/authorize";
	const parameters = new URLSearchParams();
	parameters.set("client_id", String(process.env.CLIENT_ID ?? ""));
	parameters.set("permissions", String(permissions));
	parameters.set("scope", "bot applications.commands");
	parameters.set("response_type", "code");
	parameters.set("redirect_uri", redirectUri);
	return `${base}?${parameters.toString()}`;
}

app.get("/", (request, response) => {
	if (!CLIENT_ID) {
		response
			.status(500)
			.send(
				"Missing CLIENT_ID in environment. Set CLIENT_ID and reload this page."
			);
		return;
	}

	const minimal = buildAuthUrl({
		permissions: minimalPerms,
		redirectUri: `${REDIRECT_BASE}/callback`,
	});
	const recommended = buildAuthUrl({
		permissions: recommendedPerms,
		redirectUri: `${REDIRECT_BASE}/callback`,
	});

	response.type("html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Invite Bot</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif; margin: 2rem; }
      code { background: #f4f4f4; padding: 0.15rem 0.35rem; border-radius: 4px; }
      .links { display: flex; gap: 1rem; margin-top: 1rem; }
    </style>
  </head>
  <body>
    <h1>Invite your Discord Bot</h1>
    <p>Scopes: <code>bot</code> and <code>applications.commands</code></p>
    <p>Redirect URI (must be whitelisted in the Discord Developer Portal): <code>${REDIRECT_BASE}/callback</code></p>
    <div class="links">
      <a href="${recommended}"><strong>Invite (recommended perms)</strong></a>
      <a href="${minimal}">Invite (minimal: Manage Messages + Use Application Commands)</a>
    </div>
  </body>
</html>`);
});

app.get("/invite", (request, response) => {
	const mode = request.query.mode === "minimal" ? "minimal" : "recommended";
	const url = buildAuthUrl({
		permissions: mode === "minimal" ? minimalPerms : recommendedPerms,
		redirectUri: `${REDIRECT_BASE}/callback`,
	});
	response.redirect(302, url);
});

app.get("/callback", (request, response) => {
	const { code, guild_id: guildId } = request.query;
	response.type("html").send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Invite Complete</title>
  </head>
  <body>
    <h2>Invite flow complete</h2>
    <p>Code: <code>${code ?? "(none)"}</code></p>
    <p>Guild: <code>${guildId ?? "(unknown)"}</code></p>
    <p>You can close this tab now.</p>
  </body>
	</html>`);
});

app.listen(PORT, () => {
	// Log direct URLs for convenience
	console.log(`Invite server on http://localhost:${PORT}`);
	console.log(`Recommended invite: http://localhost:${PORT}/invite`);
	console.log(`Minimal invite: http://localhost:${PORT}/invite?mode=minimal`);
});
