// apps/cli/src/diagnostics-bootstrap.ts — the CLI's ONE place where a
// diagnostics instance, its runId and its redactor are built (M3 §3.5; the W6
// plan's task 4).
//
// WHY THIS LIVES IN apps/cli AND NOT IN THE PACKAGE. §3.5 puts the REGISTERED
// VALUES at the host: the redactor's shape rules cannot see a custom gateway
// token (`Bearer corp-abc123` has no distinctive prefix), so whoever holds the
// real values has to feed them in. The CLI is that host — it is the only
// assembler that loads the settings document and, through
// `loadProviderRuntime()`, the credential store.
//
// THE TWO SOURCES OF A REGISTERED VALUE (§3.5's "registered values come from"),
// and where each is reachable from:
//
//   1. THE ENV SCAN — a NAME matching /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|
//      CREDENTIAL|AUTH)/i and a VALUE of at least 8 characters. The floor is the
//      redactor's own (`MIN_SECRET_LENGTH`; it would refuse a shorter value
//      anyway) and it is restated here because a scan's contract belongs where
//      the scan is read. WHAT THIS SCAN DOES NOT COVER is measured and named
//      rather than widened: `*_WEBHOOK`, `*_URL` and every other name outside
//      that regex fall out of it (T3's report; pinned by a case in
//      `test/diagnostics-bootstrap.test.ts`). Nor is `process.argv` scanned, so
//      a `--api-key KEY` given on the command line is not registered either.
//   2. THE DECLARED REFS — `settings.get().llm.providers[*].apiKeyEnv`, each
//      resolved through the credential store (env > file). This is not a
//      duplicate of (1): a key that lives in `credentials.json` is invisible to
//      an env scan, and the store is the only reader of it.
//
// WHEN (2) CAN RUN IS NOT THE SAME AT EVERY ENTRY, and that is the one
// asymmetry in this file. `sdk` and `acp` hold the runtime they just loaded, so
// they feed both sources in the single `createCliDiagnostics` call.
// The `run` path cannot: `runHeadless` loads the provider runtime LAZILY, inside
// the run and only when the run needs a model (`run.ts`'s `runtimeNow`), so no
// store exists when the host entry installs. The redactor is therefore kept in
// the slot below and `run.ts` calls `registerCliSecrets` at the moment its
// `loadProviderRuntime()` resolves — the earliest instant that handle exists,
// and the reason `run.ts` no longer drops `loaded.credentials`.
//
// THE LOG DESTINATION IS NOT RESOLVED HERE. `createDiagnostics` reads
// `I_HARNESS_LOG` from `process.env` (unset → console delegation; `stderr` →
// process.stderr; anything else → that path, appended per record). This file
// passes NO `stream`, deliberately: an explicit stream WINS over the env, so
// passing one would make the path mode unreachable — or force this module to
// re-implement it as an open file stream, trading the per-record
// `appendFileSync` (nothing buffered, so a line survives a crash — the case a
// diagnostics log exists for) for a buffered one. The `env` option is named for
// what it is: the source the SECRET SCAN reads. Every entry passes nothing, so
// both halves read the same `process.env`; a test passing an explicit env sets
// `I_HARNESS_LOG` on the process when it wants the structured channel.
import { randomUUID } from "node:crypto"
import type { CredentialStore } from "@i-harness/credentials"
import { createDiagnostics, createRedactor, installDiagnostics, type Diagnostics, type Redactor } from "@i-harness/diagnostics"
import type { SettingsStore } from "@i-harness/settings"

export interface CreateCliDiagnosticsOptions {
  /** Minted when absent (`randomUUID()`): ONE runId per host entry — nothing in
   *  the tree has one to lend (a storeless run has no `activeId`, and the two
   *  stdio hosts are per-session). */
  runId?: string
  /** The environment the secret scan reads. Defaults to `process.env`, which is
   *  what every entry uses; a test passes an explicit object to stay hermetic. */
  env?: NodeJS.ProcessEnv
  /** The loaded settings document, when the caller already holds one: its
   *  `llm.providers[*].apiKeyEnv` are the refs to resolve. Both this and
   *  `credentials` are needed to feed anything — one without the other is a
   *  caller that cannot answer "what is this ref's value", and guessing (the env
   *  scan, a default path) would be a second reader of a file this module has no
   *  business opening. */
  settings?: SettingsStore
  /** The credential store those refs resolve through (env > file). */
  credentials?: CredentialStore
}

export interface CliDiagnostics {
  /** The installed instance. The entries close it on every exit. */
  diagnostics: Diagnostics
  /** `installDiagnostics`'s uninstaller — see the caller's teardown for why both
   *  this and `diagnostics.close()` are called: they are different contracts
   *  (release the INSTANCE vs detach the SLOT), and the pairing discipline the
   *  plan asks for reads best when neither is implicit. */
  uninstall: () => void
}

/** §3.5's name predicate, verbatim. Deliberately not widened — see the header. */
const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i

/** §3.5's floor for a registered value, stated at the scan (the redactor
 *  enforces the same floor in `registerSecret`). */
const MIN_SECRET_LENGTH = 8

/**
 * The redactor of the instance this process installed — the ONE piece of module
 * state here, and the cost is stated rather than hidden: it is per process, and
 * exactly one CLI entry runs per process (`main()` dispatches to `run`, `sdk` or
 * `acp`, never two). It exists because the `run` path's credential store is
 * reachable only from inside the run (see the header), so a function — not the
 * entry that holds the handle — has to be able to feed it.
 *
 * The handle is never read back out: there is no getter, and the redactor's own
 * `size()`/secrets are not exposed here either (the same "no way to read the
 * registered set back out" stance the redactor takes).
 */
let cliRedactor: Redactor | undefined

/** Source (1): the env scan. Both filters are the spec's: the NAME looks like a
 *  credential, and the value is long enough to be one. */
function registerEnvSecrets(redactor: Redactor, env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(env)) {
    // `Object.entries` types the value as `string | undefined`, and an env slot
    // can genuinely be absent on some platforms.
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue
    if (!SECRET_ENV_NAME.test(name)) continue
    redactor.registerSecret(value)
  }
}

/**
 * Source (2): the declared refs, fed on the CLI's current redactor.
 *
 * Called by the `sdk`/`acp` entries at install, and by `run.ts` the moment its
 * `loadProviderRuntime()` resolves (the run path's shape — see the header). A
 * NO-OP when no CLI instance is installed: an embedder driving `runHeadless`
 * directly has no redactor to feed, and that is not an error.
 */
export function registerCliSecrets(settings: SettingsStore, credentials: CredentialStore): void {
  const redactor = cliRedactor
  if (redactor === undefined) return
  for (const provider of Object.values(settings.get().llm.providers)) {
    const ref = provider.apiKeyEnv
    if (typeof ref !== "string" || ref === "") continue
    let value: string | undefined
    try {
      value = credentials.resolve(ref)
    } catch {
      // A ref outside env grammar is REFUSED by the store (it throws), and a
      // settings document is user input. Skipping costs a masking; letting it
      // through would take the whole CLI down at startup over a redaction
      // detail, and the provider chain is where an unusable ref is refused for
      // real (it cannot resolve a client without it).
      continue
    }
    if (value !== undefined) redactor.registerSecret(value)
  }
}

/**
 * Build AND INSTALL the CLI's diagnostics instance; the returned `uninstall`
 * detaches it. `redactor` is required by the logger's own constructor, so an
 * un-redacted instance cannot be built — §3.5's first force layer, inherited.
 */
export function createCliDiagnostics(opts: CreateCliDiagnosticsOptions = {}): CliDiagnostics {
  const redactor = createRedactor()
  registerEnvSecrets(redactor, opts.env ?? process.env)
  // The slot is filled BEFORE the feed below, because the feed writes through
  // it — one reader, one writer.
  cliRedactor = redactor
  if (opts.settings !== undefined && opts.credentials !== undefined) {
    registerCliSecrets(opts.settings, opts.credentials)
  }
  const diagnostics = createDiagnostics({ runId: opts.runId ?? randomUUID(), redactor })
  const uninstall = installDiagnostics(diagnostics)
  return {
    diagnostics,
    uninstall: () => {
      uninstall()
      // A feed arriving after teardown must not write into a dead instance: the
      // slot belongs to the redactor that filled it.
      if (cliRedactor === redactor) cliRedactor = undefined
    },
  }
}
