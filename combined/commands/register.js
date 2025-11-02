import { REST, Routes } from "discord.js";

export async function registerSlashCommands({
	token,
	clientId,
	commands,
	guildId,
}) {
	const rest = new REST({ version: "10" }).setToken(token);
	const route = guildId
		? Routes.applicationGuildCommands(clientId, guildId)
		: Routes.applicationCommands(clientId);

	await rest.put(route, { body: commands });
}
