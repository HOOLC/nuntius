import { SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

export function createDiscordCommandPayload(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder()
      .setName("codex")
      .setDescription("Talk to Codex")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("ask")
          .setDescription("Send a message to Codex in the current DM or thread")
          .addStringOption((option) =>
            option
              .setName("prompt")
              .setDescription("What you want Codex to do")
              .setRequired(true)
          )
          .addStringOption((option) =>
            option
              .setName("repo")
              .setDescription("Bind or switch this conversation to a repository before asking")
              .setRequired(false)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("bind")
          .setDescription("Bind this conversation to a repository")
          .addStringOption((option) =>
            option
              .setName("repo")
              .setDescription("Repository ID")
              .setRequired(true)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("status").setDescription("Show the current conversation state")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("repos").setDescription("List repositories available here")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("reset")
          .setDescription("Reset conversation state")
          .addStringOption((option) =>
            option
              .setName("scope")
              .setDescription("Which part of the state to reset")
              .setRequired(false)
              .addChoices(
                {
                  name: "worker",
                  value: "worker"
                },
                {
                  name: "binding",
                  value: "binding"
                },
                {
                  name: "context",
                  value: "context"
                },
                {
                  name: "all",
                  value: "all"
                }
              )
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("help").setDescription("Show available Codex bridge commands")
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("codexadmin")
      .setDescription("Administrative controls for the Codex Discord bridge")
      .addSubcommand((subcommand) =>
        subcommand.setName("status").setDescription("Show runtime admin status")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("reloadconfig")
          .setDescription("Reload the TOML config and repository registry")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("hotreload")
          .setDescription("Rebuild the bridge and reconnect the Discord runtime")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("restart")
          .setDescription("Exit the process so an external supervisor can restart it")
      )
      .toJSON()
  ];
}
