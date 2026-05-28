import { EOL } from "os"
import { Effect } from "effect"
import { Provider } from "@/provider/provider"
import { ProviderID } from "../../provider/schema"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { t } from "@/i18n/index"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: t("models.list_all_available_models"),
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: t("models.provider_id_to_filter_models_by"),
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: t("models.use_more_verbose_model_output_includes_metadata_li"),
        type: "boolean",
      })
      .option("refresh", {
        describe: t("models.refresh_the_models_cache_from_modelsdev"),
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + t("models.models_cache_refreshed") + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const print = (providerID: ProviderID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sorted) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      const providerID = ProviderID.make(args.provider)
      if (!providers[providerID]) return yield* fail(t("models.provider_not_found", { args_provider: args.provider }))
      print(providerID, args.verbose)
      return
    }

    const ids = Object.keys(providers).sort((a, b) => {
      const aIsOpencode = a.startsWith("opencode")
      const bIsOpencode = b.startsWith("opencode")
      if (aIsOpencode && !bIsOpencode) return -1
      if (!aIsOpencode && bIsOpencode) return 1
      return a.localeCompare(b)
    })

    for (const providerID of ids) print(ProviderID.make(providerID), args.verbose)
  }),
})
