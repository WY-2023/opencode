import { Effect } from "effect"
import { Server } from "../../server/server"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { t } from "@/i18n/index"

export const ServeCommand = effectCmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: t("serve.starts_a_headless_opencode_server"),
  // Server loads instances per-request via x-opencode-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.serve")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log(t("serve.warning_opencodeserverpassword_is_not_set_server_i"))
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    console.log(t("serve.opencode_server_listening_on_http", { server_hostname: server.hostname, server_port: server.port }))

    yield* Effect.never
  }),
})
