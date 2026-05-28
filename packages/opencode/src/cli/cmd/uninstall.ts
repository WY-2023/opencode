import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { Global } from "@opencode-ai/core/global"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { t } from "@/i18n/index"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfig: string | null
  binary: string | null
}

export const UninstallCommand = {
  command: "uninstall",
  describe: t("uninstall.uninstall_opencode_and_remove_all_related_files"),
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: t("uninstall.keep_configuration_files"),
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: t("uninstall.keep_session_data_and_snapshots"),
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: t("uninstall.show_what_would_be_removed_without_removing"),
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: t("uninstall.skip_confirmation_prompts"),
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro(t("uninstall.uninstall_opencode"))

    const method = await Installation.method()
    prompts.log.info(t("uninstall.installation_method", { method: method }))

    const targets = await collectRemovalTargets(args, method)

    await showRemovalSummary(targets, method)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: t("uninstall.are_you_sure_you_want_to_uninstall"),
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro(t("uninstall.cancelled"))
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn(t("uninstall.dry_run_no_changes_made"))
      prompts.outro(t("uninstall.done"))
      return
    }

    await executeUninstall(method, targets)

    prompts.outro(t("uninstall.done"))
  },
}

async function collectRemovalTargets(args: UninstallArgs, method: Installation.Method): Promise<RemovalTargets> {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: t("uninstall.data"), keep: args.keepData },
    { path: Global.Path.cache, label: t("uninstall.cache"), keep: false },
    { path: Global.Path.config, label: t("uninstall.config"), keep: args.keepConfig },
    { path: Global.Path.state, label: t("uninstall.state"), keep: false },
  ]

  const shellConfig = method === "curl" ? await getShellConfigFile() : null
  const binary = method === "curl" ? process.execPath : null

  return { directories, shellConfig, binary }
}

async function showRemovalSummary(targets: RemovalTargets, method: Installation.Method) {
  prompts.log.message(t("uninstall.the_following_will_be_removed"))

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + t("uninstall.keeping") : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    prompts.log.info(`  ✓ Binary: ${shortenPath(targets.binary)}`)
  }

  if (targets.shellConfig) {
    prompts.log.info(`  ✓ Shell PATH in ${shortenPath(targets.shellConfig)}`)
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string> = {
      npm: "npm uninstall -g opencode-ai",
      pnpm: "pnpm uninstall -g opencode-ai",
      bun: "bun remove -g opencode-ai",
      yarn: "yarn global remove opencode-ai",
      brew: "brew uninstall opencode",
      choco: "choco uninstall opencode",
      scoop: "scoop uninstall opencode",
    }
    prompts.log.info(`  ✓ Package: ${cmds[method] || method}`)
  }
}

async function executeUninstall(method: Installation.Method, targets: RemovalTargets) {
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`Skipping ${dir.label} (--keep-${dir.label.toLowerCase()})`)
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(t("uninstall.removing", { dir_label: dir.label }))
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(t("uninstall.failed_to_remove", { dir_label: dir.label }), 1)
      errors.push(t("uninstall.unnamed", { dir_label: dir.label, err_message: err.message }))
      continue
    }
    spinner.stop(t("uninstall.removed", { dir_label: dir.label }))
  }

  if (targets.shellConfig) {
    spinner.start(t("uninstall.cleaning_shell_config"))
    const err = await cleanShellConfig(targets.shellConfig).catch((e) => e)
    if (err) {
      spinner.stop(t("uninstall.failed_to_clean_shell_config"), 1)
      errors.push(t("uninstall.shell_config", { err_message: err.message }))
    } else {
      spinner.stop(t("uninstall.cleaned_shell_config"))
    }
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string[]> = {
      npm: ["npm", "uninstall", "-g", "opencode-ai"],
      pnpm: ["pnpm", "uninstall", "-g", "opencode-ai"],
      bun: ["bun", "remove", "-g", "opencode-ai"],
      yarn: ["yarn", "global", "remove", "opencode-ai"],
      brew: ["brew", "uninstall", "opencode"],
      choco: ["choco", "uninstall", "opencode"],
      scoop: ["scoop", "uninstall", "opencode"],
    }

    const cmd = cmds[method]
    if (cmd) {
      spinner.start(`Running ${cmd.join(" ")}...`)
      const result = await Process.run(method === "choco" ? ["choco", "uninstall", "opencode", "-y", "-r"] : cmd, {
        nothrow: true,
      })
      if (result.code !== 0) {
        spinner.stop(t("uninstall.package_manager_uninstall_failed_exit_code", { result_code: result.code }), 1)
        const text = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`
        if (method === "choco" && text.includes("not running from an elevated command shell")) {
          prompts.log.warn(`You may need to run '${cmd.join(" ")}' from an elevated command shell`)
        } else {
          prompts.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
        }
      } else {
        spinner.stop(t("uninstall.package_removed"))
      }
    }
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    prompts.log.message(t("uninstall.to_finish_removing_the_binary_run"))
    prompts.log.info(`  rm "${targets.binary}"`)

    const binDir = path.dirname(targets.binary)
    if (binDir.includes(".opencode")) {
      prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn(t("uninstall.some_operations_failed"))
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success(t("uninstall.thank_you_for_using_opencode"))
}

async function getShellConfigFile(): Promise<string | null> {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")

  const configFiles: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [
      path.join(home, ".zshrc"),
      path.join(home, ".zshenv"),
      path.join(xdgConfig, "zsh", ".zshrc"),
      path.join(xdgConfig, "zsh", ".zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdgConfig, "bash", ".bashrc"),
      path.join(xdgConfig, "bash", ".bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".profile")],
  }

  const candidates = configFiles[shell] || configFiles.bash

  for (const file of candidates) {
    const exists = await fs
      .access(file)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const content = await Filesystem.readText(file).catch(() => "")
    if (content.includes("# opencode") || content.includes(".opencode/bin")) {
      return file
    }
  }

  return null
}

async function cleanShellConfig(file: string) {
  const content = await Filesystem.readText(file)
  const lines = content.split("\n")

  const filtered: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "# opencode") {
      skip = true
      continue
    }

    if (skip) {
      skip = false
      if (trimmed.includes(".opencode/bin") || trimmed.includes("fish_add_path")) {
        continue
      }
    }

    if (
      (trimmed.startsWith("export PATH=") && trimmed.includes(".opencode/bin")) ||
      (trimmed.startsWith("fish_add_path") && trimmed.includes(".opencode"))
    ) {
      continue
    }

    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop()
  }

  const output = filtered.join("\n") + "\n"
  await Filesystem.write(file, output)
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}
