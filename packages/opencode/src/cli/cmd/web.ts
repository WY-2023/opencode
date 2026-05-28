import { Effect } from "effect"
import { Server } from "../../server/server"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "@opencode-ai/core/flag/flag"
import open from "open"
import { networkInterfaces } from "os"
import { t } from "@/i18n/index"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: t("web.start_opencode_server_and_open_web_interface"),
  // Server loads instances per-request via x-opencode-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + t("web.opencodeserverpassword_is_not_set_server_is_unsecu"))
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + t("web.local_access"), UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + t("web.network_access"),
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + t("web.mdns"),
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser
      open(localhostUrl).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + t("web.web_interface"), UI.Style.TEXT_NORMAL, displayUrl)
      open(displayUrl).catch(() => {})
    }

    yield* Effect.never
  }),
})
