import process from "node:process";

import { REST, Routes } from "discord.js";

import { createDiscordCommandPayload } from "./discord-command-definitions.js";
import { loadDiscordBotConfig } from "./discord-config.js";

async function main(): Promise<void> {
  const discordConfig = loadDiscordBotConfig({
    requireApplicationId: true
  });
  const rest = new REST({ version: "10" }).setToken(discordConfig.token);
  const payload = createDiscordCommandPayload();

  if (discordConfig.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(discordConfig.applicationId!, discordConfig.guildId),
      {
        body: payload
      }
    );
    console.log(
      `Registered Discord commands for guild ${discordConfig.guildId} on application ${discordConfig.applicationId}.`
    );
    return;
  }

  await rest.put(Routes.applicationCommands(discordConfig.applicationId!), {
    body: payload
  });
  console.log(`Registered global Discord commands on application ${discordConfig.applicationId}.`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
