import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { Cause } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpAuth } from "../../mcp/auth"
import { McpOAuthProvider } from "../../mcp/oauth-provider"
import { Config } from "@/config/config"
import { ConfigMCP } from "../../config/mcp"
import { InstanceRef } from "@/effect/instance-ref"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { modify, applyEdits } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { Bus } from "../../bus"
import { Effect } from "effect"
import { t } from "@/i18n/index"

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return t("mcp.authenticated")
    case "expired":
      return t("mcp.expired")
    case "not_authenticated":
      return t("mcp.not_authenticated")
  }
}

type McpEntry = NonNullable<Config.Info["mcp"]>[string]

type McpConfigured = ConfigMCP.Info
function isMcpConfigured(config: McpEntry): config is McpConfigured {
  return typeof config === "object" && config !== null && "type" in config
}

type McpRemote = Extract<McpConfigured, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return isMcpConfigured(config) && config.type === "remote"
}

function configuredServers(config: Config.Info) {
  return Object.entries(config.mcp ?? {}).filter((entry): entry is [string, McpConfigured] => isMcpConfigured(entry[1]))
}

function oauthServers(config: Config.Info) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

function listState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    return { config, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: "unbounded" },
    )
    return { config, auth }
  })
}

export const McpCommand = cmd({
  command: "mcp",
  describe: t("mcp.manage_mcp_model_context_protocol_servers"),
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .demandCommand(),
  async handler() {},
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: t("mcp.list_mcp_servers_and_their_status"),
  handler: Effect.fn("Cli.mcp.list")(function* () {
    UI.empty()
    prompts.intro(t("mcp.mcp_servers"))

    const { config, statuses, stored } = yield* listState()
    const servers = configuredServers(config)

    if (servers.length === 0) {
      prompts.log.warn(t("mcp.no_mcp_servers_configured"))
      prompts.outro(t("mcp.add_servers_with_opencode_mcp_add"))
      return
    }

    for (const [name, serverConfig] of servers) {
      const status = statuses[name]
      const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
      const hasStoredTokens = stored[name]

      let statusIcon: string
      let statusText: string
      let hint = ""

      if (!status) {
        statusIcon = "○"
        statusText = t("mcp.not_initialized")
      } else if (status.status === "connected") {
        statusIcon = "✓"
        statusText = t("mcp.connected")
        if (hasOAuth && hasStoredTokens) {
          hint = " (OAuth)"
        }
      } else if (status.status === "disabled") {
        statusIcon = "○"
        statusText = t("mcp.disabled")
      } else if (status.status === "needs_auth") {
        statusIcon = "⚠"
        statusText = t("mcp.needs_authentication")
      } else if (status.status === "needs_client_registration") {
        statusIcon = "✗"
        statusText = t("mcp.needs_client_registration")
        hint = "\n    " + status.error
      } else {
        statusIcon = "✗"
        statusText = t("mcp.failed")
        hint = "\n    " + status.error
      }

      const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
      prompts.log.info(
        `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
      )
    }

    prompts.outro(t("mcp.servers", { servers_length: servers.length }))
  }),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: t("mcp.authenticate_with_an_oauth_enabled_mcp_server"),
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: t("mcp.name_of_the_mcp_server"),
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro(t("mcp.mcp_oauth_authentication"))

    const { config, auth } = yield* authState()
    const mcpServers = config.mcp ?? {}
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn(t("mcp.no_oauth_capable_mcp_servers_configured"))
      prompts.log.info(t("mcp.remote_mcp_servers_support_oauth_by_default_add_a"))
      prompts.log.info(`
  "mcp": {
    "my-server": {
      "type": "remote",
      "url": "https://example.com/mcp"
    }
  }`)
      prompts.outro(t("mcp.done"))
      return
    }

    let serverName = args.name
    if (!serverName) {
      // Build options with auth status
      const options = servers.map(([name, cfg]) => {
        const authStatus = auth[name]
        const icon = getAuthStatusIcon(authStatus)
        const statusText = getAuthStatusText(authStatus)
        const url = cfg.url
        return {
          label: `${icon} ${name} (${statusText})`,
          value: name,
          hint: url,
        }
      })

      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: t("mcp.select_mcp_server_to_authenticate"),
          options,
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) {
      prompts.log.error(t("mcp.mcp_server_not_found", { serverName: serverName }))
      prompts.outro(t("mcp.done"))
      return
    }

    if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
      prompts.log.error(t("mcp.mcp_server_is_not_an_oauth_capable_remote_server", { serverName: serverName }))
      prompts.outro(t("mcp.done"))
      return
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    if (authStatus === "authenticated") {
      const confirm = yield* Effect.promise(() =>
        prompts.confirm({
          message: t("mcp.already_has_valid_credentials_re_authenticate", { serverName: serverName }),
        }),
      )
      if (prompts.isCancel(confirm) || !confirm) {
        prompts.outro(t("mcp.cancelled"))
        return
      }
    } else if (authStatus === "expired") {
      prompts.log.warn(t("mcp.has_expired_credentials_re_authenticating", { serverName: serverName }))
    }

    const spinner = prompts.spinner()
    spinner.start(t("mcp.starting_oauth_flow"))

    // Subscribe to browser open failure events to show URL for manual opening
    const unsubscribe = Bus.subscribe(MCP.BrowserOpenFailed, (evt) => {
      if (evt.properties.mcpName === serverName) {
        spinner.stop(t("mcp.could_not_open_browser_automatically"))
        prompts.log.warn(t("mcp.please_open_this_url_in_your_browser_to_authentica"))
        prompts.log.info(evt.properties.url)
        spinner.start(t("mcp.waiting_for_authorization"))
      }
    })

    yield* MCP.Service.use((mcp) => mcp.authenticate(serverName)).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          if (status.status === "connected") {
            spinner.stop(t("mcp.authentication_successful"))
          } else if (status.status === "needs_client_registration") {
            spinner.stop(t("mcp.authentication_failed"), 1)
            prompts.log.error(status.error)
            prompts.log.info(t("mcp.add_clientid_to_your_mcp_server_config"))
            prompts.log.info(`
  "mcp": {
    "${serverName}": {
      "type": "remote",
      "url": "${serverConfig.url}",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret"
      }
    }
  }`)
          } else if (status.status === "failed") {
            spinner.stop(t("mcp.authentication_failed"), 1)
            prompts.log.error(status.error)
          } else {
            spinner.stop(t("mcp.unexpected_status") + status.status, 1)
          }
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.stop(t("mcp.authentication_failed"), 1)
          const error = Cause.squash(cause)
          prompts.log.error(error instanceof Error ? error.message : String(error))
        }),
      ),
      Effect.ensuring(Effect.sync(() => unsubscribe())),
    )

    prompts.outro(t("mcp.done"))
  }),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: t("mcp.list_oauth_capable_mcp_servers_and_their_auth_stat"),
  handler: Effect.fn("Cli.mcp.auth.list")(function* () {
    UI.empty()
    prompts.intro(t("mcp.mcp_oauth_status"))

    const { config, auth } = yield* authState()
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn(t("mcp.no_oauth_capable_mcp_servers_configured"))
      prompts.outro(t("mcp.done"))
      return
    }

    for (const [name, serverConfig] of servers) {
      const authStatus = auth[name]
      const icon = getAuthStatusIcon(authStatus)
      const statusText = getAuthStatusText(authStatus)
      const url = serverConfig.url

      prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
    }

    prompts.outro(t("mcp.oauth_capable_servers", { servers_length: servers.length }))
  }),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: t("mcp.remove_oauth_credentials_for_an_mcp_server"),
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args) {
    UI.empty()
    prompts.intro(t("mcp.mcp_oauth_logout"))

    const credentials = yield* McpAuth.Service.use((auth) => auth.all())
    const serverNames = Object.keys(credentials)

    if (serverNames.length === 0) {
      prompts.log.warn(t("mcp.no_mcp_oauth_credentials_stored"))
      prompts.outro(t("mcp.done"))
      return
    }

    let serverName = args.name
    if (!serverName) {
      const selected = yield* Effect.promise(() =>
        prompts.select({
          message: t("mcp.select_mcp_server_to_logout"),
          options: serverNames.map((name) => {
            const entry = credentials[name]
            const hasTokens = !!entry.tokens
            const hasClient = !!entry.clientInfo
            let hint = ""
            if (hasTokens && hasClient) hint = "tokens + client"
            else if (hasTokens) hint = "tokens"
            else if (hasClient) hint = "client registration"
            return {
              label: name,
              value: name,
              hint,
            }
          }),
        }),
      )
      if (prompts.isCancel(selected)) throw new UI.CancelledError()
      serverName = selected
    }

    if (!credentials[serverName]) {
      prompts.log.error(t("mcp.no_credentials_found_for", { serverName: serverName }))
      prompts.outro(t("mcp.done"))
      return
    }

    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName))
    prompts.log.success(t("mcp.removed_oauth_credentials_for", { serverName: serverName }))
    prompts.outro(t("mcp.done"))
  }),
})

async function resolveConfigPath(baseDir: string, global = false) {
  // Check for existing config files (prefer .jsonc over .json, check .opencode/ subdirectory too)
  const candidates = [path.join(baseDir, "opencode.json"), path.join(baseDir, "opencode.jsonc")]

  if (!global) {
    candidates.push(path.join(baseDir, ".opencode", "opencode.json"), path.join(baseDir, ".opencode", "opencode.jsonc"))
  }

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  // Default to opencode.json if none exist
  return candidates[0]
}

async function addMcpToConfig(name: string, mcpConfig: ConfigMCP.Info, configPath: string) {
  let text = "{}"
  if (await Filesystem.exists(configPath)) {
    text = await Filesystem.readText(configPath)
  }

  // Use jsonc-parser to modify while preserving comments
  const edits = modify(text, ["mcp", name], mcpConfig, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  })
  const result = applyEdits(text, edits)

  await Filesystem.write(configPath, result)

  return configPath
}

export const McpAddCommand = effectCmd({
  command: "add",
  describe: t("mcp.add_an_mcp_server"),
  handler: Effect.fn("Cli.mcp.add")(function* () {
    const maybeCtx = yield* InstanceRef
    if (!maybeCtx) return yield* Effect.die("InstanceRef not provided")
    const ctx = maybeCtx
    yield* Effect.promise(async () => {
      UI.empty()
      prompts.intro(t("mcp.add_mcp_server"))

      const project = ctx.project

      // Resolve config paths eagerly for hints
      const [projectConfigPath, globalConfigPath] = await Promise.all([
        resolveConfigPath(ctx.worktree),
        resolveConfigPath(Global.Path.config, true),
      ])

      // Determine scope
      let configPath = globalConfigPath
      if (project.vcs === "git") {
        const scopeResult = await prompts.select({
          message: t("mcp.location"),
          options: [
            {
              label: t("mcp.current_project"),
              value: projectConfigPath,
              hint: projectConfigPath,
            },
            {
              label: t("mcp.global"),
              value: globalConfigPath,
              hint: globalConfigPath,
            },
          ],
        })
        if (prompts.isCancel(scopeResult)) throw new UI.CancelledError()
        configPath = scopeResult
      }

      const name = await prompts.text({
        message: t("mcp.enter_mcp_server_name"),
        validate: (x) => (x && x.length > 0 ? undefined : t("mcp.required")),
      })
      if (prompts.isCancel(name)) throw new UI.CancelledError()

      const type = await prompts.select({
        message: t("mcp.select_mcp_server_type"),
        options: [
          {
            label: t("mcp.local"),
            value: "local",
            hint: t("mcp.run_a_local_command"),
          },
          {
            label: t("mcp.remote"),
            value: "remote",
            hint: t("mcp.connect_to_a_remote_url"),
          },
        ],
      })
      if (prompts.isCancel(type)) throw new UI.CancelledError()

      if (type === "local") {
        const command = await prompts.text({
          message: t("mcp.enter_command_to_run"),
          placeholder: t("mcp.eg_opencode_x_modelcontextprotocolserver_filesyste"),
          validate: (x) => (x && x.length > 0 ? undefined : t("mcp.required")),
        })
        if (prompts.isCancel(command)) throw new UI.CancelledError()

        const mcpConfig: ConfigMCP.Info = {
          type: "local",
          command: command.split(" "),
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(t("mcp.mcp_server_added_to", { name: name, configPath: configPath }))
        prompts.outro(t("mcp.mcp_server_added_successfully"))
        return
      }

      if (type === "remote") {
        const url = await prompts.text({
          message: t("mcp.enter_mcp_server_url"),
          placeholder: t("mcp.eg_httpsexamplecommcp"),
          validate: (x) => {
            if (!x) return t("mcp.required")
            if (x.length === 0) return t("mcp.required")
            const isValid = URL.canParse(x)
            return isValid ? undefined : t("mcp.invalid_url")
          },
        })
        if (prompts.isCancel(url)) throw new UI.CancelledError()

        const useOAuth = await prompts.confirm({
          message: t("mcp.does_this_server_require_oauth_authentication"),
          initialValue: false,
        })
        if (prompts.isCancel(useOAuth)) throw new UI.CancelledError()

        let mcpConfig: ConfigMCP.Info

        if (useOAuth) {
          const hasClientId = await prompts.confirm({
            message: t("mcp.do_you_have_a_pre_registered_client_id"),
            initialValue: false,
          })
          if (prompts.isCancel(hasClientId)) throw new UI.CancelledError()

          if (hasClientId) {
            const clientId = await prompts.text({
              message: t("mcp.enter_client_id"),
              validate: (x) => (x && x.length > 0 ? undefined : t("mcp.required")),
            })
            if (prompts.isCancel(clientId)) throw new UI.CancelledError()

            const hasSecret = await prompts.confirm({
              message: t("mcp.do_you_have_a_client_secret"),
              initialValue: false,
            })
            if (prompts.isCancel(hasSecret)) throw new UI.CancelledError()

            let clientSecret: string | undefined
            if (hasSecret) {
              const secret = await prompts.password({
                message: t("mcp.enter_client_secret"),
              })
              if (prompts.isCancel(secret)) throw new UI.CancelledError()
              clientSecret = secret
            }

            mcpConfig = {
              type: "remote",
              url,
              oauth: {
                clientId,
                ...(clientSecret && { clientSecret }),
              },
            }
          } else {
            mcpConfig = {
              type: "remote",
              url,
              oauth: {},
            }
          }
        } else {
          mcpConfig = {
            type: "remote",
            url,
          }
        }

        await addMcpToConfig(name, mcpConfig, configPath)
        prompts.log.success(t("mcp.mcp_server_added_to_1", { name: name, configPath: configPath }))
      }

      prompts.outro(t("mcp.mcp_server_added_successfully"))
    })
  }),
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: t("mcp.debug_oauth_connection_for_an_mcp_server"),
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.debug")(function* (args) {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    yield* Effect.promise(async () => {
      UI.empty()
      prompts.intro(t("mcp.mcp_oauth_debug"))

      const mcpServers = config.mcp ?? {}
      const serverName = args.name

      const serverConfig = mcpServers[serverName]
      if (!serverConfig) {
        prompts.log.error(t("mcp.mcp_server_not_found_1", { serverName: serverName }))
        prompts.outro(t("mcp.done"))
        return
      }

      if (!isMcpRemote(serverConfig)) {
        prompts.log.error(t("mcp.mcp_server_is_not_a_remote_server", { serverName: serverName }))
        prompts.outro(t("mcp.done"))
        return
      }

      if (serverConfig.oauth === false) {
        prompts.log.warn(t("mcp.mcp_server_has_oauth_explicitly_disabled", { serverName: serverName }))
        prompts.outro(t("mcp.done"))
        return
      }

      prompts.log.info(t("mcp.server", { serverName: serverName }))
      prompts.log.info(t("mcp.url", { serverConfig_url: serverConfig.url }))

      // Check stored auth status — services already in hand, run inline.
      const { authStatus, entry } = await Effect.runPromise(
        Effect.all({
          authStatus: mcp.getAuthStatus(serverName),
          entry: auth.get(serverName),
        }),
      )
      prompts.log.info(`Auth status: ${getAuthStatusIcon(authStatus)} ${getAuthStatusText(authStatus)}`)

      if (entry?.tokens) {
        prompts.log.info(`  Access token: ${entry.tokens.accessToken.substring(0, 20)}...`)
        if (entry.tokens.expiresAt) {
          const expiresDate = new Date(entry.tokens.expiresAt * 1000)
          const isExpired = entry.tokens.expiresAt < Date.now() / 1000
          prompts.log.info(`  Expires: ${expiresDate.toISOString()} ${isExpired ? "(EXPIRED)" : ""}`)
        }
        if (entry.tokens.refreshToken) {
          prompts.log.info(t("mcp.refresh_token_present"))
        }
      }
      if (entry?.clientInfo) {
        prompts.log.info(t("mcp.client_id", { entry_clientInfo_clientId: entry.clientInfo.clientId }))
        if (entry.clientInfo.clientSecretExpiresAt) {
          const expiresDate = new Date(entry.clientInfo.clientSecretExpiresAt * 1000)
          prompts.log.info(`  Client secret expires: ${expiresDate.toISOString()}`)
        }
      }

      const spinner = prompts.spinner()
      spinner.start(t("mcp.testing_connection"))

      // Test basic HTTP connectivity first
      try {
        const response = await fetch(serverConfig.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "opencode-debug", version: InstallationVersion },
            },
            id: 1,
          }),
        })

        spinner.stop(t("mcp.http_response", { response_status: response.status, response_statusText: response.statusText }))

        // Check for WWW-Authenticate header
        const wwwAuth = response.headers.get("www-authenticate")
        if (wwwAuth) {
          prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)
        }

        if (response.status === 401) {
          prompts.log.warn(t("mcp.server_returned_401_unauthorized"))

          // Try to discover OAuth metadata
          const oauthConfig = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined
          const authProvider = new McpOAuthProvider(
            serverName,
            serverConfig.url,
            {
              clientId: oauthConfig?.clientId,
              clientSecret: oauthConfig?.clientSecret,
              scope: oauthConfig?.scope,
              redirectUri: oauthConfig?.redirectUri,
            },
            {
              onRedirect: async () => {},
            },
            auth,
          )

          prompts.log.info(t("mcp.testing_oauth_flow_without_completing_authorizatio"))

          // Try creating transport with auth provider to trigger discovery
          const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
            authProvider,
          })

          try {
            const client = new Client({
              name: "opencode-debug",
              version: InstallationVersion,
            })
            await client.connect(transport)
            prompts.log.success(t("mcp.connection_successful_already_authenticated"))
            await client.close()
          } catch (error) {
            if (error instanceof UnauthorizedError) {
              prompts.log.info(t("mcp.oauth_flow_triggered", { error_message: error.message }))

              // Check if dynamic registration would be attempted
              const clientInfo = await authProvider.clientInformation()
              if (clientInfo) {
                prompts.log.info(t("mcp.client_id_available", { clientInfo_client_id: clientInfo.client_id }))
              } else {
                prompts.log.info(t("mcp.no_client_id_dynamic_registration_will_be_attempte"))
              }
            } else {
              prompts.log.error(`Connection error: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        } else if (response.status >= 200 && response.status < 300) {
          prompts.log.success(t("mcp.server_responded_successfully_no_auth_required_or"))
          const body = await response.text()
          try {
            const json = JSON.parse(body)
            if (json.result?.serverInfo) {
              prompts.log.info(`Server info: ${JSON.stringify(json.result.serverInfo)}`)
            }
          } catch {
            // Not JSON, ignore
          }
        } else {
          prompts.log.warn(t("mcp.unexpected_status_1", { response_status: response.status }))
          const body = await response.text().catch(() => "")
          if (body) {
            prompts.log.info(`Response body: ${body.substring(0, 500)}`)
          }
        }
      } catch (error) {
        spinner.stop(t("mcp.connection_failed"), 1)
        prompts.log.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      }

      prompts.outro(t("mcp.debug_complete"))
    })
  }),
})
