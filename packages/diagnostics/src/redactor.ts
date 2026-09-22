// packages/diagnostics/src/redactor.ts — `createRedactor`: M3 §3.5's three scans,
// and the residual said out loud instead of hidden.
//
// WHAT V1 PROMISES, EXACTLY. No secret that is matched BY NAME, BY SHAPE, or
// because it was REGISTERED leaves the process through a record. It does NOT
// promise that no secret leaves the process: a value whose key is not a
// secret-looking name, whose text matches no credential shape, and which nobody
// registered is written verbatim. That gap is not an oversight to be papered over
// — §3.5 calls the registered values "the honest part", because a shape rule
// cannot see a custom gateway token (`Authorization: Bearer corp-abc123` has no
// distinctive prefix). So the host feeds real values in, and `size()` reports how
// many are in the set: the registered set is AUDITABLE (a count a reader can
// print) rather than ASSERTED (a coverage claim a reader has to believe).
//
// THE THREE SCANS, in §3.5's order:
//
//   1. KEY NAMES. Case- and separator-insensitive, so `api_key`, `API-KEY`,
//      `apiKey` and `api.key` are one name; the value under a secret-looking name
//      is not written at all. The predicate is SUFFIX on the separator-stripped
//      name, never `includes`: `monkey` and `keychain` contain the letters of a
//      stem and are ordinary words, while `clientSecret` and `refreshToken` are
//      names a real config uses. The stems that cannot collide with a count also
//      take a plural (`apiKeys`, `credentials`), so a plural name is a NAME and its
//      value goes whole; `tokens` and `cookies` are not plurals this scan knows,
//      because a count is not a credential. `monkey` is the brief's named non-hit
//      and has a case of its own below.
//
//   2. CREDENTIAL SHAPES — `sk-…`, `Bearer <token>` (in prose: that is the
//      measured leak of the four llm adapters, whose error message is the
//      provider's response body), a PEM private-key block, URL userinfo, and long
//      base64 ONLY under a secret-looking key, because bare base64 is everywhere
//      (images, hashes, payloads) and blanket-masking it would corrupt
//      diagnostics rather than protect anything.
//
//   3. REGISTERED VALUES — exact substrings, at least 8 characters (§3.5's floor:
//      shorter values cannot be masked without corrupting unrelated text).
//
// Objects and arrays recurse, and KEYS ARE SCANNED TOO: a secret used as an
// object key is written into the record by the sink just as surely as one used as
// a value.
//
// ORDER IS NOT A SEMANTIC, BY CONSTRUCTION. A `Rule` reports the spans of the
// ORIGINAL string it wants masked (`spans`, below) and `mask` splices them in one
// pass, so no rule ever sees another rule's output. Overlapping rules therefore
// produce ONE token rather than a token inside a token, a registered value can
// never re-mask the token itself, and `extraRules` cannot change what a built-in
// matches no matter where they sit in the list.
//
// WHAT IS DELIBERATELY OUT OF REACH, named so a reader is not surprised later:
// a secret that is none of the three (the residual above). A `toJSON()` result IS
// scanned, because the JSONL sink writes that result; own non-enumerable and
// private fields are not, and neither is the sink's business. And `Bearer \S+` is
// taken at §3.5's word — the sentence "the Bearer scheme is unsupported" loses the
// word after `Bearer`, which is the price of a shape rule that cannot miss a
// header; a length floor there was NOT taken, because a short credential in prose
// would then leak.
import type { Redactor } from "./record.ts"

/** The token. Fixed by the plan: every rule replaces with exactly this, and T2's
 *  fixture cases assert it byte-for-byte. */
const TOKEN = "[REDACTED]"

/** §3.5's floor for `registerSecret`, and load-bearing beyond politeness: the
 *  registered rule searches with `indexOf`, and an empty string would match at
 *  every position forever. */
const MIN_SECRET_LENGTH = 8

/**
 * One redaction rule.
 *
 * A rule is a PREDICATE OVER TEXT, not a transformation: it reports the spans of
 * `value` it wants replaced, and the redactor does the splicing. That is what
 * makes rule order unobservable (a rule never reads a string another rule has
 * already touched) and what makes `extraRules` purely additive.
 *
 * `key` is the name the value was found under, when the caller had one — a
 * `redact(value, key)` call, or an object property. Array elements and bare
 * strings have none. Only the base64 rule reads it today; an extra rule that
 * wants to key off a name gets the same information the built-ins get.
 *
 * `name` is for a human: it is what tells two rules apart when a leak is being
 * chased, and it is what an `extraRules` author sees beside the built-ins.
 */
export interface Rule {
  readonly name: string
  spans(value: string, key?: string): readonly { start: number; end: number }[]
}

/** `api_key`, `API-KEY`, `apiKey`, `api.key` -> `apikey`. The classes are stripped
 *  rather than enumerated, so a name that arrives as `google_api_key` and one that
 *  arrives as `X_GOOG_API_KEY` normalize alike. */
function normalizedKeyName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** The key-name stems, checked as SUFFIXES of the normalized name.
 *
 *  Why suffix and not equality: `clientSecret`, `refreshToken`, `dbPassword` and
 *  `google_api_key` are all names real configuration uses, and all four should
 *  mask their value. Why not `includes`: `monkey` contains `key`, `tokenBudget`
 *  contains `token`, `cookieCount` contains `cookie` — and `tokenBudget: 4096` is a
 *  number a human reads to debug context overflow, so masking it is a lie in the
 *  record rather than a protection. Bare `key` is therefore NOT a stem, and
 *  `monkey` cannot become one by accident. */
const KEY_STEMS = [
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "hmac",
  "authorization",
  "auth",
  "bearer",
  "cookie",
] as const

/** The stems above that ALSO take a plural, matched as `stem + "s"` and nothing
 *  else. `clientSecret` was already masked while `credentials` was not, so the
 *  value under a plural name was not replaced whole — the redactor recursed into
 *  it leaf by leaf instead, and a leaf is not a name: `apiKeys: { openai:
 *  "abc123def" }` survived, because `abc123def` is neither `sk-`-shaped nor a
 *  ≥32-character base64 run. The gap was the GRANULARITY of the protection.
 *
 *  A second list rather than a trailing `s` stripped off the name before the test
 *  above: stripping is the naive form, and `maxTokens` strips to `maxtoken`, which
 *  ends with `token` — a field an existing case pins as untouched, and a count a
 *  human reads. The plural is added only where it cannot collide.
 *
 *  Deliberately absent, for two reasons a reader can check:
 *   - `token`, `cookie`, `auth`, `authorization` and `bearer` take no plural here,
 *     because `tokens: 1234` and `cookies: 3` are the very shape the comment above
 *     refuses to lie about — a count is not a credential. Bare `keys` stays
 *     unmatched too (bare `key` is not a stem, and `keys` is a name configs use
 *     for ordinary identifiers).
 *   - it costs nothing where a plural would have mattered: a CREDENTIAL-shaped
 *     value under a `*token*` name is already reached by the base64 fence, whose
 *     predicate is `includes` and therefore wider than this one.
 *
 *  The test that pairs with this list is an equality assertion on an UNTOUCHED
 *  object (`tokens`, `maxTokens`, `keywords`, `monkey`, `cookieCount`, `hotkey`,
 *  `keychain`, `author`, `turkey`, `cookies`, bare `keys`), so the narrowness is
 *  measured rather than asserted. */
const PLURAL_KEY_STEMS = ["apikey", "secret", "password", "passwd", "credential", "hmac"] as const

/** The scan ① predicate. */
function isSecretKeyName(key: string): boolean {
  const name = normalizedKeyName(key)
  return (
    KEY_STEMS.some((stem) => name.endsWith(stem)) ||
    PLURAL_KEY_STEMS.some((stem) => name.endsWith(`${stem}s`))
  )
}

/** The base64 fence's predicate — WIDER than scan ① on purpose, and the reason
 *  is measurability: a value under a key-name hit is already replaced whole by
 *  scan ①, so a base64 rule fenced by the very same predicate could never fire
 *  and `size()` would count a rule that is dead code.
 *
 *  What it buys: `keystore`, `authHeader`, `xApiKeyV2` — names that hold a
 *  credential-shaped blob but are not (and should not be) secret NAME stems.
 *  What it costs: nothing that behaves like prose, because the fence is the SHAPE
 *  in the end — the value must also contain a ≥32-character base64 run. So
 *  `monkey: "banana"` is untouched (scan ①'s named non-hit still holds), while a
 *  name containing `key` whose value IS a long base64 run is masked, which is the
 *  right answer for a nameless blob. */
const BASE64_KEY_STEMS = ["key", "token", "secret", "pass", "cred", "auth", "hmac", "bearer", "cookie"] as const

function looksLikeSecretKey(key: string): boolean {
  const name = normalizedKeyName(key)
  return BASE64_KEY_STEMS.some((stem) => name.includes(stem))
}

/** Every span a whole-match pattern finds. The patterns below are all `/g` (and
 *  `matchAll` requires that), and none of them can match empty, so every span is
 *  a real region of the string. */
function wholeSpans(value: string, pattern: RegExp): readonly { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = []
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0
    spans.push({ start, end: start + match[0].length })
  }
  return spans
}

/** A key-shaped run is `sk-` followed by a credential's worth of characters —
 *  base62 plus the `-`/`_` that real keys carry (`sk-proj-…`, `sk-ant-api03-…`).
 *
 *  The leading `\b` is not decoration: without it `disk-usage-report` and
 *  `risk-free` are matches, because English hyphenates words into `sk-` shapes.
 *  The `{8,}` floor is the other half of the same idea, so a typo is not a key. */
const SK_KEY: Rule = {
  name: "sk-key",
  spans: (value) => wholeSpans(value, /\bsk-[A-Za-z0-9_-]{8,}/g),
}

/** An authorization header's credential, INSIDE PROSE — which is why this rule
 *  exists at all: the four llm adapters throw the provider's response body, so the
 *  header line reaches a record as a substring of an error message. `\S+` rather
 *  than `[A-Za-z0-9_-]+` so a JWT (dots), a base64 header (padding `=`) and a
 *  path-ish token are all consumed. */
const BEARER: Rule = {
  name: "bearer",
  spans: (value) => wholeSpans(value, /\bBearer\s+\S+/g),
}

/** A PEM private-key block, BEGIN through END. The `|$` alternative is the
 *  truncated case: an error message cut to a length limit can carry the BEGIN line
 *  and half the body with no END anywhere, and that is a leak of key material. The
 *  cost is named rather than hidden — prose that quotes a BEGIN marker swallows
 *  the rest of its string. */
const PEM_PRIVATE_KEY: Rule = {
  name: "pem-private-key",
  spans: (value) =>
    wholeSpans(value, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g),
}

/** URL userinfo (`scheme://user:pass@host`). The span is the USERINFO, not the
 *  match: the scheme and host are what make the line worth keeping in a record,
 *  so `postgres://[REDACTED]@db.internal` is the output and the `@` stays.
 *  Userinfo without a password is included (`ghp_…@github.com` is a token in the
 *  wild), and the accepted cost is that `https://git@github.com/…` loses its
 *  username. No scheme, no rule: `ivan@example.com` is an address. */
const URL_USERINFO: Rule = {
  name: "url-userinfo",
  spans: (value) => {
    const spans: { start: number; end: number }[] = []
    for (const match of value.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/\s@]+)@/g)) {
      const at = (match.index ?? 0) + match[0].length - 1
      const start = at - (match[1] ?? "").length
      if (at > start) spans.push({ start, end: at })
    }
    return spans
  },
}

/** Long base64, fenced by its key (see `looksLikeSecretKey`). The span is the run,
 *  not the value: an operator debugging a keystore still sees the key it sat under. */
const LONG_BASE64: Rule = {
  name: "long-base64-under-secret-key",
  spans: (value, key) =>
    key !== undefined && looksLikeSecretKey(key) ? wholeSpans(value, /[A-Za-z0-9+/]{32,}={0,2}/g) : [],
}

/** Scan ③, over a live set: exact substring, every occurrence. The set is the
 *  factory's own and is never handed out — there is deliberately no way to read
 *  the registered values back out of the handle (`size()` counts them and nothing
 *  more), so a redactor cannot leak the list it holds. */
function registeredValueRule(secrets: ReadonlySet<string>): Rule {
  return {
    name: "registered-secret",
    spans: (value) => {
      const spans: { start: number; end: number }[] = []
      for (const secret of secrets) {
        for (let at = value.indexOf(secret); at !== -1; at = value.indexOf(secret, at + 1)) {
          spans.push({ start: at, end: at + secret.length })
        }
      }
      return spans
    },
  }
}

/**
 * Build one redactor.
 *
 * `extraRules` are ADDITIVE: they run beside the built-ins with the same `Rule`
 * contract, so they can name a value the built-ins cannot (the custom gateway
 * token §3.5 measured) and can never un-mask one. Their order relative to the
 * built-ins and to each other is not observable, because spans are collected
 * against the original text (see the header).
 */
export function createRedactor(opts?: { extraRules?: readonly Rule[] }): Redactor {
  const secrets = new Set<string>()
  const rules: readonly Rule[] = [
    SK_KEY,
    BEARER,
    PEM_PRIVATE_KEY,
    URL_USERINFO,
    LONG_BASE64,
    registeredValueRule(secrets),
    ...(opts?.extraRules ?? []),
  ]

  /** Replace every span every rule reported, in one splice. Overlapping spans
   *  merge into the token already emitted rather than producing a second one. */
  function mask(value: string, key: string | undefined): string {
    const spans: { start: number; end: number }[] = []
    for (const rule of rules) for (const span of rule.spans(value, key)) spans.push(span)
    if (spans.length === 0) return value
    spans.sort((a, b) => a.start - b.start || a.end - b.end)
    let out = ""
    let cursor = 0
    for (const span of spans) {
      if (span.end <= cursor) continue // inside a region already spliced
      if (span.start >= cursor) out += value.slice(cursor, span.start) + TOKEN
      cursor = span.end // a span that starts inside one extends it
    }
    return out + value.slice(cursor)
  }

  function redact(value: unknown, key?: string): unknown {
    // Scan ① first, and for the whole value whatever its type: a value under a
    // secret-looking name is not written, and type-sniffing would be a rule that
    // decides some secrets are not secrets.
    if (key !== undefined && isSecretKeyName(key)) return TOKEN
    if (typeof value === "string") return mask(value, key)
    if (Array.isArray(value)) return value.map((item) => redact(item))
    if (value === null || typeof value !== "object") return value
    // The sink writes `JSON.stringify(record)`, and for a value with `toJSON` the
    // bytes that leave are that call's RESULT — not this object's property list.
    // So the result is what gets scanned, through the same key it replaced. The
    // identity check is for a `toJSON` that returns its own receiver.
    const toJSON = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === "function") {
      const serialised = (toJSON as () => unknown).call(value)
      return serialised === value ? value : redact(serialised, key)
    }
    // A DERIVED copy, never a mutation (the same rule T2 pinned for the caught
    // Error): own enumerable properties are exactly what the sink serialises, and
    // the prototype is carried over so a Date or a class instance still serialises
    // as itself. Keys go through the same value scan.
    const copy: Record<string, unknown> = Object.create(Object.getPrototypeOf(value) as object)
    for (const [childKey, child] of Object.entries(value)) copy[mask(childKey, undefined)] = redact(child, childKey)
    return copy
  }

  return {
    redact,
    registerSecret: (value) => {
      if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return
      secrets.add(value)
    },
    // 7 built-ins (the key-name rule + five shape rules + the registered-value
    // rule) plus the caller's extras: a number a reader can reproduce.
    size: () => ({ rules: rules.length + 1, secrets: secrets.size }),
  }
}
