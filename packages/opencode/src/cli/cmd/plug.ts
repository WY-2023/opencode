import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect } from "effect"

import { ConfigPaths } from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import { installPlugin, patchPluginConfig, readPluginManifest } from "../../plugin/install"
import { resolvePluginTarget } from "../../plugin/shared"
import { errorMessage } from "../../util/error"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { t } from "@/i18n/index"

type Spin = {
  start: (msg: string) => void
  stop: (msg: string, code?: number) => void
}

export type PlugDeps = {
  spinner: () => Spin
  log: {
    error: (msg: string) => void
    info: (msg: string) => void
    success: (msg: string) => void
  }
  resolve: (spec: string) => Promise<string>
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "opencode" | "tui") => string[]
  global: string
}

export type PlugInput = {
  mod: string
  global?: boolean
  force?: boolean
}

export type PlugCtx = {
  vcs?: string
  worktree: string
  directory: string
}

const defaultPlugDeps: PlugDeps = {
  spinner: () => spinner(),
  log: {
    error: (msg) => log.error(msg),
    info: (msg) => log.info(msg),
    success: (msg) => log.success(msg),
  },
  resolve: (spec) => resolvePluginTarget(spec),
  readText: (file) => Filesystem.readText(file),
  write: async (file, text) => {
    await Filesystem.write(file, text)
  },
  exists: (file) => Filesystem.exists(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
  global: Global.Path.config,
}

function cause(err: unknown) {
  if (!err || typeof err !== "object") return
  if (!("cause" in err)) return
  return (err as { cause?: unknown }).cause
}

export function createPlugTask(input: PlugInput, dep: PlugDeps = defaultPlugDeps) {
  const mod = input.mod
  const force = Boolean(input.force)
  const global = Boolean(input.global)

  return async (ctx: PlugCtx) => {
    const install = dep.spinner()
    install.start(t("plug.installing_plugin_package"))
    const target = await installPlugin(mod, dep)
    if (!target.ok) {
      install.stop(t("plug.install_failed"), 1)
      dep.log.error(t("plug.could_not_install", { mod: mod }))
      const hit = cause(target.error) ?? target.error
      if (hit instanceof Process.RunFailedError) {
        const lines = hit.stderr
          .toString()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        const errs = lines.filter((line) => line.startsWith("error:")).map((line) => line.replace(/^error:\s*/, ""))
        const detail = errs[0] ?? lines.at(-1)
        if (detail) dep.log.error(detail)
        if (lines.some((line) => line.includes("No version matching"))) {
          dep.log.info(t("plug.this_package_depends_on_a_version_that_is_not_avai"))
          dep.log.info(t("plug.check_npm_registryauth_settings_and_try_again"))
        }
      }
      if (!(hit instanceof Process.RunFailedError)) {
        dep.log.error(errorMessage(hit))
      }
      return false
    }
    install.stop(t("plug.plugin_package_ready"))

    const inspect = dep.spinner()
    inspect.start(t("plug.reading_plugin_manifest"))
    const manifest = await readPluginManifest(target.target)
    if (!manifest.ok) {
      if (manifest.code === "manifest_read_failed") {
        inspect.stop(t("plug.manifest_read_failed"), 1)
        dep.log.error(t("plug.installed_but_failed_to_read", { mod: mod, manifest_file: manifest.file }))
        dep.log.error(errorMessage(cause(manifest.error) ?? manifest.error))
        return false
      }

      if (manifest.code === "manifest_no_targets") {
        inspect.stop(t("plug.no_plugin_targets_found"), 1)
        dep.log.error(t("plug.does_not_expose_plugin_entrypoints_in_packagejson", { mod: mod }))
        dep.log.info(
          t("plug.expected_one_of_exportstui_exportsserver_packagejs"),
        )
        return false
      }

      inspect.stop(t("plug.manifest_read_failed"), 1)
      return false
    }

    inspect.stop(
      `Detected ${manifest.targets.map((item) => item.kind).join(" + ")} target${manifest.targets.length === 1 ? "" : "s"}`,
    )

    const patch = dep.spinner()
    patch.start(t("plug.updating_plugin_config"))
    const out = await patchPluginConfig(
      {
        spec: mod,
        targets: manifest.targets,
        force,
        global,
        vcs: ctx.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
        config: dep.global,
      },
      dep,
    )
    if (!out.ok) {
      if (out.code === "invalid_json") {
        patch.stop(t("plug.failed_updating_config", { out_kind: out.kind }), 1)
        dep.log.error(t("plug.invalid_json_in_at_line_column", { out_file: out.file, out_parse: out.parse, out_line: out.line, out_col: out.col }))
        dep.log.info(t("plug.fix_the_config_file_and_run_the_command_again"))
        return false
      }

      patch.stop(t("plug.failed_updating_plugin_config"), 1)
      dep.log.error(errorMessage(out.error))
      return false
    }
    patch.stop(t("plug.plugin_config_updated"))
    for (const item of out.items) {
      if (item.mode === "noop") {
        dep.log.info(t("plug.already_configured_in", { item_file: item.file }))
        continue
      }
      if (item.mode === "replace") {
        dep.log.info(t("plug.replaced_in", { item_file: item.file }))
        continue
      }
      dep.log.info(t("plug.added_to", { item_file: item.file }))
    }

    dep.log.success(t("plug.installed", { mod: mod }))
    dep.log.info(global ? t("plug.scope_global", { out_dir: out.dir }) : `Scope: local (${out.dir})`)
    return true
  }
}

export const PluginCommand = effectCmd({
  command: "plugin <module>",
  aliases: ["plug"],
  describe: t("plug.install_plugin_and_update_config"),
  builder: (yargs) =>
    yargs
      .positional("module", {
        type: "string",
        describe: t("plug.npm_module_name"),
      })
      .option("global", {
        alias: ["g"],
        type: "boolean",
        default: false,
        describe: t("plug.install_in_global_config"),
      })
      .option("force", {
        alias: ["f"],
        type: "boolean",
        default: false,
        describe: t("plug.replace_existing_plugin_version"),
      }),
  handler: Effect.fn("Cli.plug")(function* (args) {
    const mod = String(args.module ?? "").trim()
    if (!mod) {
      UI.error(t("plug.module_is_required"))
      process.exitCode = 1
      return
    }

    UI.empty()
    intro(t("plug.install_plugin", { mod: mod }))

    const run = createPlugTask({
      mod,
      global: Boolean(args.global),
      force: Boolean(args.force),
    })

    const ctx = yield* InstanceRef
    if (!ctx) return
    const ok = yield* Effect.promise(() =>
      run({
        vcs: ctx.project.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }),
    )

    outro("Done")
    if (!ok) process.exitCode = 1
  }),
})
