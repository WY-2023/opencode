import { cmd } from "./cmd"
import { Duration, Effect, Match, Option } from "effect"
import { UI } from "../ui"
import { Account } from "@/account/account"
import { AccountID, OrgID, PollExpired, type PollResult, type AccountError } from "@/account/schema"
import { effectCmd } from "../effect-cmd"
import * as Prompt from "../effect/prompt"
import open from "open"
import { t } from "@/i18n/index"

const openBrowser = (url: string) => Effect.promise(() => open(url).catch(() => undefined))

const println = (msg: string) => Effect.sync(() => UI.println(msg))

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const activeSuffix = (isActive: boolean) => (isActive ? dim(t("account.active")) : "")

export const defaultConsoleUrl = "https://console.opencode.ai"

export const formatAccountLabel = (account: { email: string; url: string }, isActive: boolean) =>
  `${account.email} ${dim(account.url)}${activeSuffix(isActive)}`

const formatOrgChoiceLabel = (account: { email: string }, org: { name: string }, isActive: boolean) =>
  `${org.name} (${account.email})${activeSuffix(isActive)}`

export const formatOrgLine = (
  account: { email: string; url: string },
  org: { id: string; name: string },
  isActive: boolean,
) => {
  const dot = isActive ? UI.Style.TEXT_SUCCESS + "●" + UI.Style.TEXT_NORMAL : " "
  const name = isActive ? UI.Style.TEXT_HIGHLIGHT_BOLD + org.name + UI.Style.TEXT_NORMAL : org.name
  return `  ${dot} ${name}  ${dim(account.email)}  ${dim(account.url)}  ${dim(org.id)}`
}

const isActiveOrgChoice = (
  active: Option.Option<{ id: AccountID; active_org_id: OrgID | null }>,
  choice: { accountID: AccountID; orgID: OrgID },
) => Option.isSome(active) && active.value.id === choice.accountID && active.value.active_org_id === choice.orgID

const loginEffect = Effect.fn("login")(function* (url: string) {
  const service = yield* Account.Service

  yield* Prompt.intro(t("account.log_in"))
  const login = yield* service.login(url)

  yield* Prompt.log.info(t("account.go_to") + login.url)
  yield* Prompt.log.info(t("account.enter_code") + login.user)
  yield* openBrowser(login.url)

  const s = Prompt.spinner()
  yield* s.start(t("account.waiting_for_authorization"))

  const poll = (wait: Duration.Duration): Effect.Effect<PollResult, AccountError> =>
    Effect.gen(function* () {
      yield* Effect.sleep(wait)
      const result = yield* service.poll(login)
      if (result._tag === "PollPending") return yield* poll(wait)
      if (result._tag === "PollSlow") return yield* poll(Duration.sum(wait, Duration.seconds(5)))
      return result
    })

  const result = yield* poll(login.interval).pipe(
    Effect.timeout(login.expiry),
    Effect.catchTag("TimeoutError", () => Effect.succeed(new PollExpired())),
  )

  yield* Match.valueTags(result, {
    PollSuccess: (r) =>
      Effect.gen(function* () {
        yield* s.stop(t("account.logged_in_as") + r.email)
        yield* Prompt.outro(t("account.done"))
      }),
    PollExpired: () => s.stop(t("account.device_code_expired"), 1),
    PollDenied: () => s.stop(t("account.authorization_denied"), 1),
    PollError: (r) => s.stop(t("account.error") + String(r.cause), 1),
    PollPending: () => s.stop(t("account.unexpected_state"), 1),
    PollSlow: () => s.stop(t("account.unexpected_state"), 1),
  })
})

const logoutEffect = Effect.fn("logout")(function* (email?: string) {
  const service = yield* Account.Service
  const accounts = yield* service.list()
  if (accounts.length === 0) return yield* println(t("account.not_logged_in"))

  if (email) {
    const match = accounts.find((a) => a.email === email)
    if (!match) return yield* println(t("account.account_not_found") + email)
    yield* service.remove(match.id)
    yield* Prompt.outro(t("account.logged_out_from") + email)
    return
  }

  const active = yield* service.active()
  const activeID = Option.map(active, (a) => a.id)

  yield* Prompt.intro(t("account.log_out"))

  const opts = accounts.map((a) => {
    const isActive = Option.isSome(activeID) && activeID.value === a.id
    return {
      value: a,
      label: formatAccountLabel(a, isActive),
    }
  })

  const selected = yield* Prompt.select({ message: t("account.select_account_to_log_out"), options: opts })
  if (Option.isNone(selected)) return

  yield* service.remove(selected.value.id)
  yield* Prompt.outro(t("account.logged_out_from") + selected.value.email)
})

interface OrgChoice {
  orgID: OrgID
  accountID: AccountID
  label: string
}

const switchEffect = Effect.fn("switch")(function* () {
  const service = yield* Account.Service

  const groups = yield* service.orgsByAccount()
  if (groups.length === 0) return yield* println(t("account.not_logged_in"))

  const active = yield* service.active()

  const opts = groups.flatMap((group) =>
    group.orgs.map((org) => {
      const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
      return {
        value: { orgID: org.id, accountID: group.account.id, label: org.name },
        label: formatOrgChoiceLabel(group.account, org, isActive),
      }
    }),
  )
  if (opts.length === 0) return yield* println(t("account.no_orgs_found"))

  yield* Prompt.intro(t("account.switch_org"))

  const selected = yield* Prompt.select<OrgChoice>({ message: t("account.select_org"), options: opts })
  if (Option.isNone(selected)) return

  const choice = selected.value
  yield* service.use(choice.accountID, Option.some(choice.orgID))
  yield* Prompt.outro(t("account.switched_to") + choice.label)
})

const orgsEffect = Effect.fn("orgs")(function* () {
  const service = yield* Account.Service

  const groups = yield* service.orgsByAccount()
  if (groups.length === 0) return yield* println(t("account.no_accounts_found"))
  if (!groups.some((group) => group.orgs.length > 0)) return yield* println(t("account.no_orgs_found"))

  const active = yield* service.active()

  for (const group of groups) {
    for (const org of group.orgs) {
      const isActive = isActiveOrgChoice(active, { accountID: group.account.id, orgID: org.id })
      yield* println(formatOrgLine(group.account, org, isActive))
    }
  }
})

const openEffect = Effect.fn("open")(function* () {
  const service = yield* Account.Service
  const active = yield* service.active()
  if (Option.isNone(active)) return yield* println(t("account.no_active_account"))

  const url = active.value.url
  yield* openBrowser(url)
  yield* Prompt.outro(t("account.opened") + url)
})

export const LoginCommand = effectCmd({
  command: "login [url]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs.positional("url", {
      describe: t("account.server_url"),
      type: "string",
    }),
  handler: Effect.fn("Cli.account.login")(function* (args) {
    UI.empty()
    yield* Effect.orDie(loginEffect(args.url ?? defaultConsoleUrl))
  }),
})

export const LogoutCommand = effectCmd({
  command: "logout [email]",
  describe: false,
  instance: false,
  builder: (yargs) =>
    yargs.positional("email", {
      describe: t("account.account_email_to_log_out_from"),
      type: "string",
    }),
  handler: Effect.fn("Cli.account.logout")(function* (args) {
    UI.empty()
    yield* Effect.orDie(logoutEffect(args.email))
  }),
})

export const SwitchCommand = effectCmd({
  command: "switch",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.switch")(function* () {
    UI.empty()
    yield* Effect.orDie(switchEffect())
  }),
})

export const OrgsCommand = effectCmd({
  command: "orgs",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.orgs")(function* () {
    UI.empty()
    yield* Effect.orDie(orgsEffect())
  }),
})

export const OpenCommand = effectCmd({
  command: "open",
  describe: false,
  instance: false,
  handler: Effect.fn("Cli.account.open")(function* () {
    UI.empty()
    yield* Effect.orDie(openEffect())
  }),
})

export const ConsoleCommand = cmd({
  command: "console",
  describe: false,
  builder: (yargs) =>
    yargs
      .command({
        ...LoginCommand,
        describe: t("account.log_in_to_console"),
      })
      .command({
        ...LogoutCommand,
        describe: t("account.log_out_from_console"),
      })
      .command({
        ...SwitchCommand,
        describe: t("account.switch_active_org"),
      })
      .command({
        ...OrgsCommand,
        describe: t("account.list_orgs"),
      })
      .command({
        ...OpenCommand,
        describe: t("account.open_active_console_account"),
      })
      .demandCommand(),
  async handler() {},
})
