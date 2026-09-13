#!/usr/bin/env node
// scripts/audit/fill-grok-model.mjs
//
// Fills grok's EMPTY `model` domain array, which the D3 matrix currently renders
// as "?" (not inventoried this pass). A dispatched agent ran for twelve hours
// without writing anything, so this is done directly from the source instead.
//
// Only the model array is touched. The other eleven domains are complete and have
// been through crosswalk and adversarial verification; changing them would
// invalidate reviewed work.
//
// Every entry below was read from the file it cites. Nothing is inferred from a
// crate name.

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const P = join(ROOT, "docs/audit/data/2026-09-11-d3-grok.json")
const doc = JSON.parse(readFileSync(P, "utf8"))

const G = "crates/codegen"

const model = [
  {
    name: "embedded-default-model-catalogue-with-precedence-chain",
    what: "Model ids are not hard-coded in Rust: `default_models.json` is embedded into the binary with `include_str!` and parsed once behind a `LazyLock`. The loader asserts at first use that the named `default` also appears in the `models` array, so a mismatched baked-in JSON fails loudly at startup rather than silently resolving to an unknown id. Each model resolves from the first of these that is set -- CLI flag, ENV var, config.toml, remote settings, then these compiled defaults.",
    invariants: [
      "The resolved default must be a member of the models array; the startup assert makes a developer error fatal rather than silent.",
      "Four roles resolve independently (coding, web search, image description, session summary); the three non-coding roles fall back to `default` when unset, so an absent role key is not an error.",
    ],
    failurePolicy: "fail-closed at startup: an invalid or inconsistent embedded JSON panics in the LazyLock initialiser rather than degrading to a guessed model",
    constants: [
      { name: "resolution precedence", value: "CLI flag > ENV > config.toml > remote settings > embedded defaults", evidence: `${G}/xai-grok-models/src/lib.rs:4` },
    ],
    evidence: [`${G}/xai-grok-models/src/lib.rs:10`, `${G}/xai-grok-models/src/lib.rs:29-42`, `${G}/xai-grok-models/src/lib.rs:45-68`],
    modules: ["xai-grok-models"],
    verified: true,
  },
  {
    name: "sampler-retry-policy-with-env-and-per-model-overrides",
    what: "The sampling client's retry budget resolves through three layers: a GROK_MAX_RETRIES environment override, then a per-model setting, then a compiled default of 15 attempts. Backoff is exponential from a 2000ms base, clamped at 30s, with jitter derived from an incrementing atomic sequence rather than a random source. A separate 200ms transport-rebuild backoff is used when the underlying connection has to be re-established rather than merely retried.",
    invariants: [
      "Retry count resolution is env > per-model > default; a model's own setting cannot exceed what the environment override asks for.",
      "Rate-limit handling is threshold-based rather than universal: the retry threshold is 2 and 1 disables rate-limit retrying entirely, so a 429 is not always retried.",
    ],
    failurePolicy: "bounded retry then surface: exhaustion returns the last error rather than retrying indefinitely",
    constants: [
      { name: "DEFAULT_MAX_RETRIES", value: "15", evidence: `${G}/xai-grok-sampler/src/retry.rs:9` },
      { name: "MAX_RETRY_BACKOFF", value: "30s", evidence: `${G}/xai-grok-sampler/src/retry.rs:11` },
      { name: "TRANSPORT_REBUILD_BACKOFF", value: "200ms", evidence: `${G}/xai-grok-sampler/src/retry.rs:13` },
      { name: "RATE_LIMIT_RETRY_THRESHOLD", value: "2 (1 disables)", evidence: `${G}/xai-grok-sampler/src/retry.rs:5-7` },
    ],
    evidence: [`${G}/xai-grok-sampler/src/retry.rs:15-27`, `${G}/xai-grok-sampler/src/retry.rs:42-51`],
    modules: ["xai-grok-sampler"],
    verified: true,
  },
  {
    name: "doom-loop-detection-and-system-reminder-recovery",
    what: "A signal collector peeks at the in-flight response and distinguishes two cases: a check event that carries loop signals directly, and a response field that does not; a missing or poisoned state degrades to an empty signal list rather than failing the stream. Recovery injects a system reminder telling the model its output was flagged as looping, and bounds what it re-sends with separate reasoning and text budgets.",
    invariants: [
      "Recovery truncates rather than drops: reasoning is capped at 8KiB and text at 4KiB, each with a visible truncation marker, so the model sees that content was removed.",
      "A failed state peek yields no signals -- the loop detector fails soft so it cannot itself break a response.",
    ],
    failurePolicy: "fail-soft on detection (empty signals on error), fail-closed on recovery budget (bounded re-send)",
    constants: [
      { name: "MAX_RECOVERY_REASONING_BYTES", value: "8192", evidence: `${G}/xai-grok-sampler/src/doom_loop_recovery.rs:29` },
      { name: "MAX_RECOVERY_TEXT_BYTES", value: "4096", evidence: `${G}/xai-grok-sampler/src/doom_loop_recovery.rs:30` },
    ],
    evidence: [`${G}/xai-grok-sampler/src/doom_loop.rs:72-93`, `${G}/xai-grok-sampler/src/doom_loop_recovery.rs:23`, `${G}/xai-grok-sampler/src/doom_loop_recovery.rs:148-149`],
    modules: ["xai-grok-sampler"],
    verified: true,
  },
  {
    name: "refresh-aware-credential-provider-with-401-recovery",
    what: "Outbound auth is a single trait that is a supertrait of the header-building HttpAuth, so one implementation satisfies both header construction and refresh-aware snapshotting. `snapshot()` is documented to issue a cheap disk re-read first, so a token rotated by a sibling process (`grok-desktop`, or a `grok login` in another shell) becomes visible without restart. `refresh_after_unauthorized()` returns whether a DIFFERENT token was obtained, and the caller retries the failed request exactly once on true.",
    invariants: [
      "`snapshot().token` must mirror the bearer that `apply()` would put on the wire, because the 401-attribution telemetry prefixes are matched against it.",
      "`needs_token_auth_header()` is false for deployment keys (bare Bearer) and true for user/OAuth tokens -- the wire format differs by credential class.",
      "Each identity field has a distinct None meaning: absent auth, a provider with no notion of user identity, or a personal account rather than a team one.",
    ],
    failurePolicy: "fail-closed by default: `has_usable_credential()` defaults to true, but an implementation may return false to avoid an outbound attempt that cannot succeed",
    constants: [],
    evidence: [
      `${G}/xai-grok-auth/src/auth_provider.rs:34-57`,
      `${G}/xai-grok-auth/src/auth_provider.rs:11-27`,
      `${G}/xai-grok-auth/src/auth_provider.rs:93-102`,
    ],
    modules: ["xai-grok-auth"],
    verified: true,
  },
  {
    name: "outbound-secret-sanitizer",
    what: "A regex-based redactor runs over outbound payloads before they leave the process. It covers API-key prefixes, AWS access keys, GitHub tokens, vendor tokens, Google API keys, PEM private keys, bearer tokens, JWTs and `secret=`-style assignments, replacing matched text with a fixed marker and URL query values with the literal `redacted`. A separate sensitive-query-parameter list handles values that carry no recognisable prefix shape.",
    invariants: [
      "Redaction is replacement, not removal, so a reader can see that something was suppressed at that position.",
      "URL query parameters are sanitised by name against an explicit list, which catches credentials that no prefix regex would match.",
    ],
    failurePolicy: "fail-closed in effect: anything matching a known credential shape is replaced before transmission",
    constants: [
      { name: "REDACTED", value: "\"[REDACTED_SECRET]\"", evidence: `${G}/xai-grok-secrets/src/sanitizer.rs:5` },
      { name: "REDACTED_URL_VALUE", value: "\"redacted\"", evidence: `${G}/xai-grok-secrets/src/sanitizer.rs:6` },
    ],
    evidence: [`${G}/xai-grok-secrets/src/sanitizer.rs:10-35`, `${G}/xai-grok-secrets/src/sanitizer.rs:53`],
    modules: ["xai-grok-secrets"],
    verified: true,
  },
  {
    name: "bounded-connection-prewarm",
    what: "Origins are prewarmed ahead of use with an explicit timeout and a cap on how many origins are tracked, and the response body of a prewarm is drained up to a fixed byte cap so the connection returns to the pool rather than being closed. The caps keep prewarming from becoming an unbounded background cost as a session touches more hosts.",
    invariants: [
      "Prewarm is bounded in all three dimensions: time, tracked origins, and bytes drained -- none of them may grow with session length.",
    ],
    failurePolicy: "fail-soft: a prewarm that times out or exceeds its drain cap costs a connection, not the request",
    constants: [
      { name: "PREWARM_TIMEOUT", value: "15s", evidence: `${G}/xai-grok-sampler/src/prewarm.rs:12` },
      { name: "DRAIN_CAP_BYTES", value: "65536", evidence: `${G}/xai-grok-sampler/src/prewarm.rs:14` },
      { name: "MAX_TRACKED_ORIGINS", value: "32", evidence: `${G}/xai-grok-sampler/src/prewarm.rs:16` },
    ],
    evidence: [`${G}/xai-grok-sampler/src/prewarm.rs:12-16`, `${G}/xai-grok-sampler/src/prewarm.rs:52`],
    modules: ["xai-grok-sampler"],
    verified: true,
  },
]

if (doc.domains.model.length > 0) {
  console.error(`! grok's model array is not empty (${doc.domains.model.length} entries) -- refusing to overwrite reviewed work`)
  process.exit(1)
}
doc.domains.model = model
doc._modelFilledBy =
  "scripts/audit/fill-grok-model.mjs -- read directly from the cited files after a dispatched agent ran twelve hours without writing. Other domains untouched."

writeFileSync(P, JSON.stringify(doc, null, 2) + "\n", "utf8")
JSON.parse(readFileSync(P, "utf8"))
console.log(`filled grok model: ${model.length} mechanisms`)
console.log(`  evidence entries: ${model.reduce((a, m) => a + m.evidence.length, 0)}`)
console.log(`  total mechanisms now: ${Object.values(doc.domains).reduce((a, l) => a + l.length, 0)}`)
