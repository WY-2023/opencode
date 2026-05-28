import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Flag } from "@opencode-ai/core/flag/flag"
import os from "os"
import { Duration, Effect } from "effect"
import { Config } from "@/config/config"
import { ConfigPlugin } from "@/config/plugin"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { ConfigCommand } from "./config"
import { FileCommand } from "./file"
import { LSPCommand } from "./lsp"
import { RipgrepCommand } from "./ripgrep"
import { ScrapCommand } from "./scrap"
import { SkillCommand } from "./skill"
import { SnapshotCommand } from "./snapshot"
import { AgentCommand } from "./agent"
import { StartupCommand } from "./startup"
import { V2Command } from "./v2"
import { t } from "@/i18n/index"

export const DebugCommand = cmd({
  command: "debug",
  describe: t("index.debugging_and_troubleshooting_tools"),
  builder: (yargs) =>
    yargs
      .command(ConfigCommand)
      .command(LSPCommand)
      .command(RipgrepCommand)
      .command(FileCommand)
      .command(ScrapCommand)
      .command(SkillCommand)
      .command(SnapshotCommand)
      .command(StartupCommand)
      .command(AgentCommand)
      .command(V2Command)
      .command(InfoCommand)
      .command(PathsCommand)
      .command(WaitCommand)
      .demandCommand(),
  async handler() {},
})

const WaitCommand = effectCmd({
  command: "wait",
  describe: t("index.wait_indefinitely_for_debugging"),
  handler: Effect.fn("Cli.debug.wait")(function* () {
    yield* Effect.sleep(Duration.days(1))
  }),
})

const InfoCommand = effectCmd({
  command: "info",
  describe: t("index.show_debug_information"),
  handler: Effect.fn("Cli.debug.info")(function* () {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const termProgram = process.env.TERM_PROGRAM
      ? `${process.env.TERM_PROGRAM}${process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""}`
      : undefined
    const terminal = [termProgram, process.env.TERM].filter((item): item is string => Boolean(item)).join(" / ")

    console.log(t("index.opencode_version", { InstallationVersion: InstallationVersion }))
    console.log(`os: ${os.type()} ${os.release()} ${os.arch()}`)
    console.log(t("index.terminal", { terminal_unknown: terminal || "unknown" }))
    console.log(t("index.plugins"))
    if (Flag.OPENCODE_PURE) {
      console.log(t("index.external_plugins_disabled_pure"))
      return
    }
    if (!config.plugin_origins?.length) {
      console.log(t("index.none"))
      return
    }
    for (const plugin of config.plugin_origins) {
      console.log(`- ${ConfigPlugin.pluginSpecifier(plugin.spec)}`)
    }
  }),
})

const PathsCommand = cmd({
  command: "paths",
  describe: t("index.show_global_paths_data_config_cache_state"),
  handler() {
    for (const [key, value] of Object.entries(Global.Path)) {
      console.log(key.padEnd(10), value)
    }
  },
})
