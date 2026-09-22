// packages/diagnostics/test/redactor.test.ts — TDD for `createRedactor`: M3
// §3.5's three scans (key names, credential shapes, registered values), the
// recursion into objects and arrays, the auditable count, and the leak-regression
// payload that is §3.5's third and last enforcement layer.
//
// WHY EVERY POSITIVE HAS A NAMED NON-HIT BESIDE IT: the graded property of a
// redactor is not "it masks secrets", it is "it masks secrets and stops there".
// So `monkey` (a key name containing `key`), `tokenBudget` (a name containing
// `token`), `disk-usage-report` (prose containing `sk-`), a 48-character base64
// blob under `notes` (the design's own reason bare base64 is not blanket-ruled),
// and a 7-character registration all sit next to their rules. A rule that cannot
// be shown to stop is a rule that corrupts a diagnostic somewhere else.
//
// THE TOKEN IS SPELLED OUT, not imported: `[REDACTED]` is fixed by the plan and
// asserted byte-for-byte. A test that referred to a constant could not notice the
// constant changing.
import { expect, it } from "vitest"
import { createRedactor, type Rule } from "../src/index.ts"

const TOKEN = "[REDACTED]"

/** A 48-character base64 run — long enough for the `{32,}` floor, and the kind of
 *  value that is genuinely everywhere (images, hashes, payloads), which is the
 *  whole reason that rule is fenced by its key. */
const B64 = "c2tfbGl2ZS1pbi1iYXNlNjQtd2hpY2gtaXMtNDAgY2hhcnM="

const PEM_BLOCK = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEAvQ8bQk3H2yq1loremipsumdolorsitamet",
  "-----END RSA PRIVATE KEY-----",
].join("\n")

/** A rule written the way an `extraRules` author would have to write one: the
 *  spans of the string that this rule wants replaced by the token. */
function spansFor(value: string, pattern: RegExp): readonly { start: number; end: number }[] {
  return [...value.matchAll(pattern)].map((m) => ({
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }))
}

// ----------------------------------------------------- ① the key-name scan

it("key names ignore case and separators, and the value under one goes", () => {
  // M3 §3.5 names the first three spellings; the rest are the same rule seen
  // through the separator strip (`_`, `-`, `.`) and the no-case-boundary strip.
  const out = createRedactor().redact({
    api_key: "v1",
    "API-KEY": "v2",
    apiKey: "v3",
    "api.key": "v4",
    google_api_key: "v5",
    clientSecret: "v6",
    refreshToken: "v7",
    dbPassword: "v8",
    sessionCookie: "v9",
    requestHMAC: "v10",
    X_GOOG_API_KEY: "v11",
  }) as Record<string, string>

  expect(Object.values(out)).toEqual(Array(11).fill(TOKEN))
})

it("key names: a name that merely CONTAINS a stem is not one", () => {
  // This is the `monkey` case of the brief, in its full company. Each of these
  // would be masked by an `includes(stem)` rule and would be a lie in a record:
  // a `tokenBudget` of 4096 is a number a human reads to debug context overflow.
  const untouched = {
    monkey: "banana",
    tokenBudget: 4096,
    maxTokens: 8192,
    author: "Ivan",
    keywords: "a, b",
    cookieCount: 3,
    hotkey: "ctrl+k",
    turkey: "gobble",
    keychain: "login",
  }

  expect(createRedactor().redact(untouched)).toEqual(untouched)
})

it("a key-name hit masks the whole value, whatever its type — and a nested one is found by recursion", () => {
  const r = createRedactor()

  expect(r.redact({ deep: true }, "apiKey")).toBe(TOKEN)
  expect(r.redact(42, "token")).toBe(TOKEN)
  expect(r.redact({ llm: { providers: [{ apiKey: "sk-live-ABC123" }] } })).toEqual({
    llm: { providers: [{ apiKey: TOKEN }] },
  })
})

// ----------------------------------------------------- ② the shape scan

it("shape sk-: a key-shaped run goes, and the leading boundary is what keeps prose out of it", () => {
  const r = createRedactor()

  expect(r.redact("openai rejected sk-live-ABC123 (401)")).toBe("openai rejected [REDACTED] (401)")
  // WITHOUT `\b` the rule eats `sk-usage-report` out of this sentence — a
  // hyphenated English word, which is why the boundary is not decoration.
  const prose = "risk-free, task-force and disk-usage-report are prose"
  expect(r.redact(prose)).toBe(prose)
  // A floor under the run: `sk-abc` carries three characters where a real key
  // carries eight or more, so a stub is not a key.
  expect(r.redact("sk-abc")).toBe("sk-abc")
})

it("shape Bearer: a credential inside ordinary prose is masked, and the prose survives", () => {
  // The measured leak shape of the four llm adapters: the provider's response
  // body, echoed into an error message, carrying the credential back. Nothing
  // about `corp-abc123` is distinctive — the header prefix is the only signal.
  const msg = 'openai-compatible request failed: 401 {"error":"bad key","echo":"Authorization: Bearer corp-abc123"}'

  const out = createRedactor().redact(msg)

  expect(out).not.toContain("corp-abc123")
  expect(out).toContain(TOKEN)
  expect(out).toContain("request failed: 401")
})

it("shape PEM: BEGIN through END is one token, and a message truncated mid-block still loses the block", () => {
  const r = createRedactor()

  const whole = r.redact(`could not parse the key:\n${PEM_BLOCK}\n(truncated by the provider)`)
  expect(whole).not.toContain("PRIVATE KEY")
  expect(whole).not.toContain("MIIEow")
  expect(whole).toContain(TOKEN)
  // The mask stops at END: what follows is the diagnostic, not the key.
  expect(whole).toContain("(truncated by the provider)")

  // No END marker: an error message truncated to a length limit is exactly how
  // half a key reaches a log, and the lazy match has to fall back to end-of-text.
  const half = r.redact("failed to parse -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq")
  expect(half).toContain(TOKEN)
  expect(half).not.toContain("MIIEvQ")
  expect(half).not.toContain("PRIVATE KEY")
})

it("shape URL userinfo: the credentials go, the scheme and the host stay", () => {
  const r = createRedactor()

  // The host is what makes the line worth keeping in a record; the credentials
  // are the only part that has to go, so the rule reports the userinfo span and
  // not the whole URL.
  expect(r.redact("cannot connect: postgres://harness:s3cret-pw@db.internal:5432/app")).toBe(
    "cannot connect: postgres://[REDACTED]@db.internal:5432/app",
  )
  // Userinfo without a password is a token in the wild (`x-access-token@`,
  // `ghp_…@`), so the rule does not require the colon.
  expect(r.redact("https://ghp_0123456789@github.com/o/r")).toBe("https://[REDACTED]@github.com/o/r")
  // The named non-hit: an `@` with no scheme is an address, not userinfo.
  expect(r.redact("mail ivan@example.com")).toBe("mail ivan@example.com")
})

it("shape long base64: only under a secret-looking key, and only when it IS base64", () => {
  const r = createRedactor()

  // `keystore` is not one of the key-name stems (it does not end with one), so
  // this is the case that makes the fenced rule reachable rather than dead code.
  expect(r.redact({ keystore: B64 })).toEqual({ keystore: TOKEN })
  // The named rejection, and the design's own reason: bare base64 is too common
  // to blanket-rule, so a `notes` or `payload` field keeps its bytes.
  expect(r.redact({ notes: B64, payload: B64 })).toEqual({ notes: B64, payload: B64 })
  // The fence opens on the NAME and closes on the SHAPE: prose under the same
  // key is not base64 and is not touched.
  expect(r.redact({ keystore: "the keystore lives at /etc/i-harness/keys" })).toEqual({
    keystore: "the keystore lives at /etc/i-harness/keys",
  })
})

// ----------------------------------------------------- ③ the registered pass

it("registered values: an exact substring of 8 characters or more, and a 7-character value is refused", () => {
  const r = createRedactor()
  r.registerSecret("corp-abc123")
  r.registerSecret("short7!")

  expect(r.redact("the gateway said corp-abc123 was rejected")).toBe("the gateway said [REDACTED] was rejected")
  // 7 characters is below the floor (M3 §3.5): a value that short cannot be
  // masked without corrupting unrelated text.
  expect(r.redact("the gateway said short7! was rejected")).toBe("the gateway said short7! was rejected")
  expect(r.size()).toEqual({ rules: 7, secrets: 1 })
})

it("registered values: one registered value masks what the shape fence refuses", () => {
  const r = createRedactor()

  expect(r.redact({ notes: B64 })).toEqual({ notes: B64 })
  r.registerSecret(B64)
  expect(r.redact({ notes: B64 })).toEqual({ notes: TOKEN })
})

it("registered values are masked wherever they sit — in a nested value, and in a KEY", () => {
  // §3.5: keys and values are both scanned. A secret used as an object key is
  // written into the record by the sink just as surely as one used as a value.
  const r = createRedactor()
  r.registerSecret("corp-abc123")

  const out = r.redact({ list: [[{ deep: "corp-abc123" }]], "corp-abc123": "used as a key" })

  expect(JSON.stringify(out)).not.toContain("corp-abc123")
  // The KEY position is the assertion: a redactor that scanned only values would
  // leave the object keyed by the secret and pass the search above only by luck.
  expect(Object.keys(out as Record<string, unknown>)).toEqual(["list", TOKEN])
})

// ----------------------------------------------------- ④ recursion and shape

it("nested objects and arrays recurse, and the input is not mutated", () => {
  const r = createRedactor()
  const input = { turn: { calls: [{ url: "https://ghp_0123456789@github.com/o/r" }, { api_key: "sk-live-ABC123" }] } }

  const out = r.redact(input)

  expect(out).toEqual({ turn: { calls: [{ url: "https://[REDACTED]@github.com/o/r" }, { api_key: TOKEN }] } })
  // The record is a DERIVED copy: the caller's object keeps its bytes, the same
  // rule T2 pinned for the caught Error.
  expect(input).toEqual({ turn: { calls: [{ url: "https://ghp_0123456789@github.com/o/r" }, { api_key: "sk-live-ABC123" }] } })
})

it("redact returns the shape it was given, and the values no rule names are passed through", () => {
  const r = createRedactor()

  expect(typeof r.redact("plain")).toBe("string")
  expect(Array.isArray(r.redact(["plain"]))).toBe(true)
  expect(r.redact(42)).toBe(42)
  expect(r.redact(true)).toBe(true)
  expect(r.redact(null)).toBe(null)
  expect(r.redact(undefined)).toBe(undefined)
})

it("an object that serialises itself through toJSON is scanned through the door the sink uses", () => {
  // The JSONL sink writes `JSON.stringify(record)`, so for a value with toJSON
  // the bytes that leave the process are toJSON()'s RESULT — not the object's own
  // property list. Scanning only the properties would write the key out unmasked.
  const cfg = { toJSON: () => ({ apiKey: "sk-live-ABC123", region: "eu" }) }

  const out = createRedactor().redact({ cfg })

  expect(JSON.stringify(out)).not.toContain("sk-live-ABC123")
  expect(JSON.stringify(out)).toContain(TOKEN)
})

it("redacting twice is a no-op: no rule ever sees another rule's output", () => {
  const redactor = createRedactor()
  redactor.registerSecret("corp-abc123")
  const once = redactor.redact({ msg: "Bearer corp-abc123", api_key: "sk-live-ABC123" })

  expect(redactor.redact(once)).toEqual(once)
})

// ----------------------------------------------------- ⑤ the auditable count

it("size(): rules counts every rule the instance holds, secrets counts the DISTINCT registered values", () => {
  // 7 = the key-name rule + five shape rules + the registered-value rule.
  expect(createRedactor().size()).toEqual({ rules: 7, secrets: 0 })

  const extra: Rule = { name: "corp-gateway", spans: (value) => spansFor(value, /corp-[0-9a-f]{6,}/g) }
  const withExtra = createRedactor({ extraRules: [extra] })
  expect(withExtra.size()).toEqual({ rules: 8, secrets: 0 })

  withExtra.registerSecret("corp-abc123")
  withExtra.registerSecret("corp-abc123")
  withExtra.registerSecret("x")
  expect(withExtra.size()).toEqual({ rules: 8, secrets: 1 })
})

// ----------------------------------------------------- ④ extraRules

it("extraRules are additive: they mask what no built-in can name, and they cannot un-mask", () => {
  const corp: Rule = { name: "corp-gateway-token", spans: (value) => spansFor(value, /corp-[0-9a-f]{6,}/g) }
  const r = createRedactor({ extraRules: [corp] })

  // Nothing about `corp-9f2b1c77` is a shape (§3.5's measured point: a custom
  // gateway token has no distinctive prefix) — this is what extras are for.
  expect(r.redact("gateway rejected corp-9f2b1c77")).toBe("gateway rejected [REDACTED]")
  // Additive: the built-in scans are all still in force beside it.
  expect(r.redact("openai rejected sk-live-ABC123")).toBe("openai rejected [REDACTED]")
})

it("rule order never changes the output: spans are read off the ORIGINAL text and spliced once", () => {
  // Two rules whose spans overlap, in both orders. A sequential masker would
  // tokenise the first match and then match inside its own token, or lose the
  // wider match entirely; collecting spans first makes the output the same set of
  // regions either way.
  const inner: Rule = { name: "inner", spans: (value) => spansFor(value, /X{8}/g) }
  const outer: Rule = { name: "outer", spans: (value) => spansFor(value, /X{16}/g) }

  const forward = createRedactor({ extraRules: [inner, outer] }).redact("a XXXXXXXX XXXXXXXX b")
  const reverse = createRedactor({ extraRules: [outer, inner] }).redact("a XXXXXXXX XXXXXXXX b")

  expect(forward).toBe("a [REDACTED] [REDACTED] b")
  expect(reverse).toBe(forward)
  // The built-ins overlap the same way: the Bearer header and the `sk-` run are
  // one region, so the header prefix goes with the credential instead of
  // producing two tokens or a half-masked header.
  expect(createRedactor().redact("Authorization: Bearer sk-live-ABC123")).toBe("Authorization: [REDACTED]")
})

// ----------------------------------------------------- ⑥ the leak regression

it("leak regression: a payload carrying every rule's sample loses every sample", () => {
  // §3.5's third layer of enforcement, and the only assertion that can fail when
  // a rule is missing: seed known plaintext, search the OUTPUT. A test that
  // asserted `redact` was called would pass under a no-op implementation.
  const samples = [
    ["sk- shape", "sk-live-ABC123"],
    ["Bearer in prose", "corp-abc123"],
    ["PEM body", "MIIEowIBAAKCAQEAvQ8bQk3H2yq1"],
    ["URL password", "s3cret-pw"],
    ["base64 under a secret-looking key", B64],
    ["registered value", "reg-value-99"],
  ] as const

  const payload = {
    // adversarial key names, the shape D4 asks for: none of these is a secret
    // name, so nothing here is masked by the key pass
    prose: "gateway rejected Authorization: Bearer corp-abc123 after openai rejected sk-live-ABC123",
    notes: PEM_BLOCK,
    conn: "postgres://harness:s3cret-pw@db.internal:5432/app",
    keystore: B64,
    context: [{ deeper: [{ args: ["reg-value-99"] }] }],
    ["reg-value-99"]: "used as a key",
  }

  const redactor = createRedactor()
  redactor.registerSecret("reg-value-99")

  const wire = JSON.stringify(redactor.redact(payload))!

  expect(wire).toContain(TOKEN)
  for (const [rule, sample] of samples) expect(wire, `${rule}: ${sample} survived`).not.toContain(sample)
  // Not vacuous in the other direction either: the payload the sink would write
  // is much larger than a page of tokens, so the search above is a real search.
  expect(wire.length).toBeGreaterThan(100)
})
