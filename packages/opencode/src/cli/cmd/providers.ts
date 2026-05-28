import { Auth } from "../../auth"
import { cmd } from "./cmd"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { ModelsDev } from "@opencode-ai/core/models-dev"

import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "@/config/config"
import { Global } from "@opencode-ai/core/global"
import { Plugin } from "../../plugin"
import type { Hooks } from "@opencode-ai/plugin"
import { Process } from "@/util/process"
import { errorMessage } from "@/util/error"
import { text } from "node:stream/consumers"
import { Effect, Option } from "effect"
import { t } from "@/i18n/index"

type PluginAuth = NonNullable<Hooks["auth"]>

const promptValue = <Value>(value: Option.Option<Value>) => {
  if (Option.isNone(value)) return Effect.die(new UI.CancelledError())
  return Effect.succeed(value.value)
}

const put = Effect.fn("Cli.providers.put")(function* (key: string, info: Auth.Info) {
  const auth = yield* Auth.Service
  yield* Effect.orDie(auth.set(key, info))
})

const cliTry = <Value>(message: string, fn: () => PromiseLike<Value>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => new CliError({ message: message + errorMessage(error) }),
  })

const handlePluginAuth = Effect.fn("Cli.providers.pluginAuth")(function* (
  plugin: { auth: PluginAuth },
  provider: string,
  methodName?: string,
) {
  const index = yield* Effect.gen(function* () {
    if (!methodName) {
      if (plugin.auth.methods.length <= 1) return 0
      return yield* promptValue(
        yield* Prompt.select({
          message: t("providers.login_method"),
          options: plugin.auth.methods.map((x, index) => ({
            label: x.label,
            value: index,
          })),
        }),
      )
    }
    const match = plugin.auth.methods.findIndex((x) => x.label.toLowerCase() === methodName.toLowerCase())
    if (match === -1) {
      return yield* fail(
        `Unknown method "${methodName}" for ${provider}. Available: ${plugin.auth.methods.map((x) => x.label).join(", ")}`,
      )
    }
    return match
  })
  const method = plugin.auth.methods[index]

  yield* Effect.sleep("10 millis")
  const inputs: Record<string, string> = {}
  if (method.prompts) {
    for (const prompt of method.prompts) {
      if (prompt.when) {
        const value = inputs[prompt.when.key]
        if (value === undefined) continue
        const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
        if (!matches) continue
      }
      if (prompt.condition && !prompt.condition(inputs)) continue
      if (prompt.type === "select") {
        const value = yield* Prompt.select({
          message: prompt.message,
          options: prompt.options,
        })
        inputs[prompt.key] = yield* promptValue(value)
        continue
      }
      const value = yield* Prompt.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        validate: prompt.validate ? (v) => prompt.validate!(v ?? "") : undefined,
      })
      inputs[prompt.key] = yield* promptValue(value)
    }
  }

  if (method.type === "oauth") {
    const authorize = yield* cliTry(t("providers.failed_to_authorize"), () => method.authorize(inputs))

    if (authorize.url) {
      yield* Prompt.log.info(t("providers.go_to") + authorize.url)
    }

    if (authorize.method === "auto") {
      if (authorize.instructions) {
        yield* Prompt.log.info(authorize.instructions)
      }
      const spinner = Prompt.spinner()
      yield* spinner.start(t("providers.waiting_for_authorization"))
      const result = yield* cliTry(t("providers.failed_to_authorize"), () => authorize.callback())
      if (result.type === "failed") {
        yield* spinner.stop(t("providers.failed_to_authorize_1"), 1)
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          yield* put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          yield* put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        yield* spinner.stop(t("providers.login_successful"))
      }
    }

    if (authorize.method === "code") {
      const code = yield* Prompt.text({
        message: t("providers.paste_the_authorization_code_here"),
        validate: (x) => (x && x.length > 0 ? undefined : t("providers.required")),
      })
      const authorizationCode = yield* promptValue(code)
      const result = yield* cliTry(t("providers.failed_to_authorize"), () => authorize.callback(authorizationCode))
      if (result.type === "failed") {
        yield* Prompt.log.error(t("providers.failed_to_authorize_2"))
      }
      if (result.type === "success") {
        const saveProvider = result.provider ?? provider
        if ("refresh" in result) {
          const { type: _, provider: __, refresh, access, expires, ...extraFields } = result
          yield* put(saveProvider, {
            type: "oauth",
            refresh,
            access,
            expires,
            ...extraFields,
          })
        }
        if ("key" in result) {
          yield* put(saveProvider, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        }
        yield* Prompt.log.success(t("providers.login_successful"))
      }
    }

    yield* Prompt.outro(t("providers.done"))
    return true
  }

  if (method.type === "api") {
    const key = yield* Prompt.password({
      message: t("providers.enter_your_api_key"),
      validate: (x) => (x && x.length > 0 ? undefined : t("providers.required")),
    })
    const apiKey = yield* promptValue(key)

    const metadata = Object.keys(inputs).length ? { metadata: inputs } : {}
    const authorizeApi = method.authorize
    if (!authorizeApi) {
      yield* put(provider, {
        type: "api",
        key: apiKey,
        ...metadata,
      })
      yield* Prompt.outro(t("providers.done"))
      return true
    }

    const result = yield* cliTry(t("providers.failed_to_authorize"), () => authorizeApi(inputs))
    if (result.type === "failed") {
      yield* Prompt.log.error(t("providers.failed_to_authorize_4"))
    }
    if (result.type === "success") {
      const saveProvider = result.provider ?? provider
      const merged = { ...(metadata.metadata ?? {}), ...(result.metadata ?? {}) }
      yield* put(saveProvider, {
        type: "api",
        key: result.key ?? apiKey,
        ...(Object.keys(merged).length ? { metadata: merged } : {}),
      })
      yield* Prompt.log.success(t("providers.login_successful"))
    }
    yield* Prompt.outro(t("providers.done"))
    return true
  }

  return false
})

export function resolvePluginProviders(input: {
  hooks: Hooks[]
  existingProviders: Record<string, unknown>
  disabled: Set<string>
  enabled?: Set<string>
  providerNames: Record<string, string | undefined>
}): Array<{ id: string; name: string }> {
  const seen = new Set<string>()
  const result: Array<{ id: string; name: string }> = []

  for (const hook of input.hooks) {
    if (!hook.auth) continue
    const id = hook.auth.provider
    if (seen.has(id)) continue
    seen.add(id)
    if (Object.hasOwn(input.existingProviders, id)) continue
    if (input.disabled.has(id)) continue
    if (input.enabled && !input.enabled.has(id)) continue
    result.push({
      id,
      name: input.providerNames[id] ?? id,
    })
  }

  return result
}

export const ProvidersCommand = cmd({
  command: "providers",
  aliases: ["auth"],
  describe: t("providers.manage_ai_providers_and_credentials"),
  builder: (yargs) =>
    yargs.command(ProvidersListCommand).command(ProvidersLoginCommand).command(ProvidersLogoutCommand).demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: t("providers.list_providers_and_credentials"),
  // Lists global credentials + provider env vars; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.list")(function* (_args) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service

    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    yield* Prompt.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = Object.entries(yield* Effect.orDie(authSvc.all()))
    const database = yield* modelsDev.get()

    for (const [providerID, result] of results) {
      const name = database[providerID]?.name || providerID
      yield* Prompt.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    yield* Prompt.outro(`${results.length} credentials`)

    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      yield* Prompt.intro(t("providers.environment"))

      for (const { provider, envVar } of activeEnvVars) {
        yield* Prompt.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      yield* Prompt.outro(t("providers.environment_variable", { activeEnvVars_length: activeEnvVars.length }) + (activeEnvVars.length === 1 ? "" : "s"))
    }
  }),
})

export const ProvidersLoginCommand = effectCmd({
  command: "login [url]",
  describe: t("providers.log_in_to_a_provider"),
  builder: (yargs) =>
    yargs
      .positional("url", {
        describe: t("providers.opencode_auth_provider"),
        type: "string",
      })
      .option("provider", {
        alias: ["p"],
        describe: t("providers.provider_id_or_name_to_log_in_to_skips_provider_se"),
        type: "string",
      })
      .option("method", {
        alias: ["m"],
        describe: t("providers.login_method_label_skips_method_selection"),
        type: "string",
      }),
  handler: Effect.fn("Cli.providers.login")(function* (args) {
    const authSvc = yield* Auth.Service

    UI.empty()
    yield* Prompt.intro(t("providers.add_credential"))
    if (args.url) {
      const url = args.url.replace(/\/+$/, "")
      const wellknown = (yield* cliTry(t("providers.failed_to_load_auth_provider_metadata_from", { url: url }), () =>
        fetch(`${url}/.well-known/opencode`).then((x) => x.json()),
      )) as {
        auth: { command: string[]; env: string }
      }
      yield* Prompt.log.info(`Running \`${wellknown.auth.command.join(" ")}\``)
      const abort = new AbortController()
      const proc = Process.spawn(wellknown.auth.command, { stdout: "pipe", stderr: "inherit", abort: abort.signal })
      if (!proc.stdout) {
        yield* Prompt.log.error(t("providers.failed"))
        yield* Prompt.outro(t("providers.done"))
        return
      }
      const [exit, token] = yield* cliTry(t("providers.failed_to_run_auth_provider_command"), () =>
        Promise.all([proc.exited, text(proc.stdout!)]),
      ).pipe(Effect.ensuring(Effect.sync(() => abort.abort())))
      if (exit !== 0) {
        yield* Prompt.log.error(t("providers.failed"))
        yield* Prompt.outro(t("providers.done"))
        return
      }
      yield* Effect.orDie(authSvc.set(url, { type: "wellknown", key: wellknown.auth.env, token: token.trim() }))
      yield* Prompt.log.success(t("providers.logged_into") + url)
      yield* Prompt.outro(t("providers.done"))
      return
    }

    const cfgSvc = yield* Config.Service
    const pluginSvc = yield* Plugin.Service
    const modelsDev = yield* ModelsDev.Service
    yield* Effect.ignore(modelsDev.refresh(true))

    const config = yield* cfgSvc.get()

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

    const allProviders = yield* modelsDev.get()
    const providers: Record<string, (typeof allProviders)[string]> = {}
    for (const [key, value] of Object.entries(allProviders)) {
      if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) providers[key] = value
    }
    const hooks = yield* pluginSvc.list()

    const priority: Record<string, number> = {
      opencode: 0,
      openai: 1,
      "github-copilot": 2,
      google: 3,
      anthropic: 4,
      openrouter: 5,
      vercel: 6,
    }
    const pluginProviders = resolvePluginProviders({
      hooks,
      existingProviders: providers,
      disabled,
      enabled,
      providerNames: Object.fromEntries(Object.entries(config.provider ?? {}).map(([id, p]) => [id, p.name])),
    })
    const options = [
      ...pipe(
        providers,
        values(),
        sortBy(
          (x) => priority[x.id] ?? 99,
          (x) => x.name ?? x.id,
        ),
        map((x) => ({
          label: x.name,
          value: x.id,
          hint: {
            opencode: t("providers.recommended"),
            openai: t("providers.chatgpt_pluspro_or_api_key"),
          }[x.id],
        })),
      ),
      ...pluginProviders.map((x) => ({
        label: x.name,
        value: x.id,
        hint: t("providers.plugin"),
      })),
    ]

    let provider: string
    if (args.provider) {
      const input = args.provider
      const byID = options.find((x) => x.value === input)
      const byName = options.find((x) => x.label.toLowerCase() === input.toLowerCase())
      const match = byID ?? byName
      if (!match) {
        return yield* fail(t("providers.unknown_provider", { input: input }))
      }
      provider = match.value
    } else {
      provider = yield* promptValue(
        yield* Prompt.autocomplete({
          message: t("providers.select_provider"),
          maxItems: 8,
          options: [...options, { value: t("providers.other"), label: "Other" }],
        }),
      )
    }

    const plugin = hooks.findLast((x) => x.auth?.provider === provider)
    if (plugin && plugin.auth) {
      const handled = yield* handlePluginAuth({ auth: plugin.auth! }, provider, args.method)
      if (handled) return
    }

    if (provider === "other") {
      provider = (yield* promptValue(
        yield* Prompt.text({
          message: t("providers.enter_provider_id"),
          validate: (x) => (x && x.match(/^[0-9a-z-]+$/) ? undefined : t("providers.a_z_0_9_and_hyphens_only")),
        }),
      )).replace(/^@ai-sdk\//, "")

      const customPlugin = hooks.findLast((x) => x.auth?.provider === provider)
      if (customPlugin && customPlugin.auth) {
        const handled = yield* handlePluginAuth({ auth: customPlugin.auth! }, provider, args.method)
        if (handled) return
      }

      yield* Prompt.log.warn(
        t("providers.this_only_stores_a_credential_for_you_will_need_co", { provider: provider }),
      )
    }

    if (provider === "amazon-bedrock") {
      yield* Prompt.log.info(
        t("providers.amazon_bedrock_authentication_priorityn") +
          t("providers.1_bearer_token_awsbearertokenbedrock_or_connectn") +
          t("providers.2_aws_credential_chain_profile_access_keys_iam_rol") +
          t("providers.configure_via_opencodejson_options_profile_region") +
          t("providers.aws_environment_variables_awsprofile_awsregion_aws"),
      )
    }

    if (provider === "opencode") {
      yield* Prompt.log.info(t("providers.create_an_api_key_at_httpsopencodeaiauth"))
    }

    if (provider === "vercel") {
      yield* Prompt.log.info(t("providers.you_can_create_an_api_key_at_httpsvercellinkai_gat"))
    }

    if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
      yield* Prompt.log.info(
        t("providers.cloudflare_ai_gateway_can_be_configured_with_cloud"),
      )
    }

    const key = yield* Prompt.password({
      message: t("providers.enter_your_api_key"),
      validate: (x) => (x && x.length > 0 ? undefined : t("providers.required")),
    })
    const apiKey = yield* promptValue(key)
    yield* Effect.orDie(authSvc.set(provider, { type: "api", key: apiKey }))

    yield* Prompt.outro(t("providers.done"))
  }),
})

export const ProvidersLogoutCommand = effectCmd({
  command: "logout",
  describe: t("providers.log_out_from_a_configured_provider"),
  // Removes a global auth credential; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.logout")(function* (_args) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service

    UI.empty()
    const credentials: Array<[string, Auth.Info]> = Object.entries(yield* Effect.orDie(authSvc.all()))
    yield* Prompt.intro(t("providers.remove_credential"))
    if (credentials.length === 0) {
      yield* Prompt.log.error(t("providers.no_credentials_found"))
      return
    }
    const database = yield* modelsDev.get()
    const selected = yield* Prompt.select({
      message: t("providers.select_provider"),
      options: credentials.map(([key, value]) => ({
        label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
        value: key,
      })),
    })
    yield* Effect.orDie(authSvc.remove(yield* promptValue(selected)))
    yield* Prompt.outro(t("providers.logout_successful"))
  }),
})
