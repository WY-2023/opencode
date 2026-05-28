import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { Git } from "@/git"
import { InstanceRef } from "@/effect/instance-ref"
import { Process } from "@/util/process"
import { t } from "@/i18n/index"

export const PrCommand = effectCmd({
  command: "pr <number>",
  describe: t("pr.fetch_and_checkout_a_github_pr_branch_then_run_ope"),
  builder: (yargs) =>
    yargs.positional("number", {
      type: "number",
      describe: t("pr.pr_number_to_checkout"),
      demandOption: true,
    }),
  handler: Effect.fn("Cli.pr")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* fail("Could not load instance context")
    if (ctx.project.vcs !== "git") {
      return yield* fail(t("pr.could_not_find_git_repository_please_run_this_comm"))
    }

    const git = yield* Git.Service
    const worktree = ctx.worktree

    const prNumber = args.number
    const localBranchName = `pr/${prNumber}`
    UI.println(t("pr.fetching_and_checking_out_pr", { prNumber: prNumber }))

    const checkout = yield* Effect.promise(() =>
      Process.run(["gh", "pr", "checkout", `${prNumber}`, "--branch", localBranchName, "--force"], { nothrow: true }),
    )
    if (checkout.code !== 0) {
      return yield* fail(t("pr.failed_to_checkout_pr_make_sure_you_have_gh_cli_in", { prNumber: prNumber }))
    }

    const prInfoResult = yield* Effect.promise(() =>
      Process.text(
        [
          "gh",
          "pr",
          "view",
          `${prNumber}`,
          "--json",
          "headRepository,headRepositoryOwner,isCrossRepository,headRefName,body",
        ],
        { nothrow: true },
      ),
    )

    let sessionId: string | undefined

    if (prInfoResult.code === 0 && prInfoResult.text.trim()) {
      const prInfo = JSON.parse(prInfoResult.text)

      if (prInfo?.isCrossRepository && prInfo.headRepository && prInfo.headRepositoryOwner) {
        const forkOwner = prInfo.headRepositoryOwner.login
        const forkName = prInfo.headRepository.name
        const remoteName = forkOwner

        const remotes = (yield* git.run(["remote"], { cwd: worktree })).text().trim()
        if (!remotes.split("\n").includes(remoteName)) {
          yield* git.run(["remote", "add", remoteName, `https://github.com/${forkOwner}/${forkName}.git`], {
            cwd: worktree,
          })
          UI.println(t("pr.added_fork_remote", { remoteName: remoteName }))
        }

        yield* git.run(["branch", `--set-upstream-to=${remoteName}/${prInfo.headRefName}`, localBranchName], {
          cwd: worktree,
        })
      }

      if (prInfo?.body) {
        const sessionMatch = prInfo.body.match(/https:\/\/opncd\.ai\/s\/([a-zA-Z0-9_-]+)/)
        if (sessionMatch) {
          const sessionUrl = sessionMatch[0]
          UI.println(t("pr.found_opencode_session", { sessionUrl: sessionUrl }))
          UI.println(t("pr.importing_session"))

          const importResult = yield* Effect.promise(() =>
            Process.text(["opencode", "import", sessionUrl], { nothrow: true }),
          )
          if (importResult.code === 0) {
            const sessionIdMatch = importResult.text.trim().match(/Imported session: ([a-zA-Z0-9_-]+)/)
            if (sessionIdMatch) {
              sessionId = sessionIdMatch[1]
              UI.println(t("pr.session_imported", { sessionId: sessionId }))
            }
          }
        }
      }
    }

    UI.println(t("pr.successfully_checked_out_pr_as_branch", { prNumber: prNumber, localBranchName: localBranchName }))
    UI.println()
    UI.println(t("pr.starting_opencode"))
    UI.println()

    const opencodeArgs = sessionId ? ["-s", sessionId] : []
    const code = yield* Effect.promise(
      () =>
        Process.spawn(["opencode", ...opencodeArgs], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          cwd: process.cwd(),
        }).exited,
    )
    // Match legacy throw semantics — propagate as a defect so the top-level
    // index.ts catch handles it identically (exit 1, "Unexpected error" banner).
    if (code !== 0) return yield* Effect.die(new Error(`opencode exited with code ${code}`))
  }),
})
