import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { Global } from "@opencode-ai/core/global"
import { Agent } from "../../agent/agent"
import { Provider } from "@/provider/provider"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import matter from "gray-matter"
import { InstanceRef } from "@/effect/instance-ref"
import { EOL } from "os"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { t } from "@/i18n/index"

type AgentMode = "all" | "primary" | "subagent"

// Permission keys (not raw tool names). Multiple tools can map to a single
// permission — e.g. write/edit/apply_patch all gate on `edit` — so we configure
// agents at the permission level to match how the runtime actually enforces it.
const AVAILABLE_PERMISSIONS = [
  "bash",
  "read",
  "edit",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "websearch",
  "lsp",
  "skill",
]

const AgentCreateCommand = effectCmd({
  command: "create",
  describe: t("agent.create_a_new_agent"),
  builder: (yargs: Argv) =>
    yargs
      .option("path", {
        type: "string",
        describe: t("agent.directory_path_to_generate_the_agent_file"),
      })
      .option("description", {
        type: "string",
        describe: t("agent.what_the_agent_should_do"),
      })
      .option("mode", {
        type: "string",
        describe: t("agent.agent_mode"),
        choices: ["all", "primary", "subagent"] as const,
      })
      .option("permissions", {
        type: "string",
        alias: ["tools"],
        describe: `comma-separated list of permissions to allow (default: all). Available: "${AVAILABLE_PERMISSIONS.join(", ")}"`,
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: t("agent.model_to_use_in_the_format_of_providermodel"),
      }),
  handler: Effect.fn("Cli.agent.create")(function* (args) {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    const agentSvc = yield* Agent.Service
    const runLocalEffect = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect.pipe(Effect.provideService(InstanceRef, ctx)))
    yield* Effect.promise(async () => {
      const cliPath = args.path
      const cliDescription = args.description
      const cliMode = args.mode as AgentMode | undefined
      const perms = args.permissions

      const isFullyNonInteractive = cliPath && cliDescription && cliMode && perms !== undefined

      if (!isFullyNonInteractive) {
        UI.empty()
        prompts.intro(t("agent.create_agent"))
      }

      const project = ctx.project

      // Determine scope/path
      let targetPath: string
      if (cliPath) {
        targetPath = path.join(cliPath, "agents")
      } else {
        let scope: "global" | "project" = "global"
        if (project.vcs === "git") {
          const scopeResult = await prompts.select({
            message: t("agent.location"),
            options: [
              {
                label: t("agent.current_project"),
                value: "project" as const,
                hint: ctx.worktree,
              },
              {
                label: t("agent.global"),
                value: "global" as const,
                hint: Global.Path.config,
              },
            ],
          })
          if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
          scope = scopeResult
        }
        targetPath = path.join(scope === "global" ? Global.Path.config : path.join(ctx.worktree, ".opencode"), "agents")
      }

      // Get description
      let description: string
      if (cliDescription) {
        description = cliDescription
      } else {
        const query = await prompts.text({
          message: t("agent.description"),
          placeholder: t("agent.what_should_this_agent_do"),
          validate: (x) => (x && x.length > 0 ? undefined : t("agent.required")),
        })
        if (prompts.isCancel(query)) throw new UI.CancelledError()
        description = query
      }

      // Generate agent
      const spinner = prompts.spinner()
      spinner.start(t("agent.generating_agent_configuration"))
      const model = args.model ? Provider.parseModel(args.model) : undefined
      const generated = await runLocalEffect(agentSvc.generate({ description, model })).catch((error) => {
        spinner.stop(t("agent.llm_failed_to_generate_agent", { error_message: error.message }), 1)
        if (isFullyNonInteractive) process.exit(1)
        throw new UI.CancelledError()
      })
      spinner.stop(t("agent.agent_generated", { generated_identifier: generated.identifier }))

      // Select permissions to allow
      let selected: string[]
      if (perms !== undefined) {
        selected = perms ? perms.split(",").map((t) => t.trim()) : AVAILABLE_PERMISSIONS
      } else {
        const result = await prompts.multiselect({
          message: t("agent.select_permissions_to_allow_space_to_toggle"),
          options: AVAILABLE_PERMISSIONS.map((permission) => ({
            label: permission,
            value: permission,
          })),
          initialValues: AVAILABLE_PERMISSIONS,
        })
        if (prompts.isCancel(result)) throw new UI.CancelledError()
        selected = result
      }

      // Get mode
      let mode: AgentMode
      if (cliMode) {
        mode = cliMode
      } else {
        const modeResult = await prompts.select({
          message: t("agent.agent_mode_1"),
          options: [
            {
              label: t("agent.all"),
              value: "all" as const,
              hint: t("agent.can_function_in_both_primary_and_subagent_roles"),
            },
            {
              label: t("agent.primary"),
              value: "primary" as const,
              hint: t("agent.acts_as_a_primarymain_agent"),
            },
            {
              label: t("agent.subagent"),
              value: "subagent" as const,
              hint: t("agent.can_be_used_as_a_subagent_by_other_agents"),
            },
          ],
          initialValue: "all" as const,
        })
        if (prompts.isCancel(modeResult)) throw new UI.CancelledError()
        mode = modeResult
      }

      // Build permissions config — deny anything not explicitly selected.
      const permissions: Record<string, "deny"> = {}
      for (const permission of AVAILABLE_PERMISSIONS) {
        if (!selected.includes(permission)) {
          permissions[permission] = "deny"
        }
      }

      // Build frontmatter
      const frontmatter: {
        description: string
        mode: AgentMode
        permission?: Record<string, "deny">
      } = {
        description: generated.whenToUse,
        mode,
      }
      if (Object.keys(permissions).length > 0) {
        frontmatter.permission = permissions
      }

      // Write file
      const content = matter.stringify(generated.systemPrompt, frontmatter)
      const filePath = path.join(targetPath, `${generated.identifier}.md`)

      await fs.mkdir(targetPath, { recursive: true })

      if (await Filesystem.exists(filePath)) {
        if (isFullyNonInteractive) {
          console.error(`Error: Agent file already exists: ${filePath}`)
          process.exit(1)
        }
        prompts.log.error(t("agent.agent_file_already_exists", { filePath: filePath }))
        throw new UI.CancelledError()
      }

      await Filesystem.write(filePath, content)

      if (isFullyNonInteractive) {
        console.log(filePath)
      } else {
        prompts.log.success(t("agent.agent_created", { filePath: filePath }))
        prompts.outro(t("agent.done"))
      }
    })
  }),
})

const AgentListCommand = effectCmd({
  command: "list",
  describe: t("agent.list_all_available_agents"),
  handler: Effect.fn("Cli.agent.list")(function* () {
    const agents = yield* Agent.Service.use((svc) => svc.list())
    const sortedAgents = agents.sort((a, b) => {
      if (a.native !== b.native) {
        return a.native ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    for (const agent of sortedAgents) {
      process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
      process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
    }
  }),
})

export const AgentCommand = cmd({
  command: "agent",
  describe: t("agent.manage_agents"),
  builder: (yargs) => yargs.command(AgentCreateCommand).command(AgentListCommand).demandCommand(),
  async handler() {},
})
