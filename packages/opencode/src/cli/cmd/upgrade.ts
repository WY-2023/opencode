import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { t } from "@/i18n/index"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: t("upgrade.upgrade_opencode_to_the_latest_or_a_specific_versi"),
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: t("upgrade.version_to_upgrade_to_for_ex_0148_or_v0148"),
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: t("upgrade.installation_method_to_use"),
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro(t("upgrade.upgrade"))
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(t("upgrade.opencode_is_installed_to_and_may_be_managed_by_a_p", { process_execPath: process.execPath }))
      const install = await prompts.select({
        message: t("upgrade.install_anyways"),
        options: [
          { label: t("upgrade.yes"), value: true },
          { label: t("upgrade.no"), value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro(t("upgrade.done"))
        return
      }
    }
    prompts.log.info(t("upgrade.using_method") + method)
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

    if (InstallationVersion === target) {
      prompts.log.warn(t("upgrade.opencode_upgrade_skipped_is_already_installed", { target: target }))
      prompts.outro(t("upgrade.done"))
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start(t("upgrade.upgrading"))
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop(t("upgrade.upgrade_failed"), 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error(t("upgrade.please_run_the_terminal_as_administrator_and_try_a"))
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro(t("upgrade.done"))
      return
    }
    spinner.stop(t("upgrade.upgrade_complete"))
    prompts.outro(t("upgrade.done"))
  },
}
