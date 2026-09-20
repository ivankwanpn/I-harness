// The SUBSET is measured, not copied — spec §3.2. IH's 61 literal declarations
// use exactly these keywords (counts in the spec), and a verbatim port of dsh's
// validator would both reject three constructs IH legitimately writes and lack
// three IH uses. The two subsets contain each other in neither direction.
// (§3.6.1 is the one branch the measurement forced after §3.6 was written:
// `additionalProperties` is a BOOLEAN *or* a SCHEMA — workflow/src/tool.ts:73
// declares a map of name→string with the schema form.)
//
// THE ONE PROPERTY THAT MATTERS: this function is TOTAL FOR JSON-SHAPED INPUT.
// It reports, it never throws, and it never coerces — for arbitrary JSON-shaped
// values against arbitrary JSON-shaped schemas. That is the whole reason it can
// run on a schema this repo did not write (MCP forwards the remote server's
// schema verbatim, mcp-client/bridge.ts), and it is the class that actually
// arrives: args come from JSON.parse, schemas are literals or JSON-parsed
// server responses.
//
// THE QUALIFIER IS MEASURED, not defensive wording. 4,000 randomized
// JSON-shaped cases (schema and value both round-tripped through JSON) raised 0
// throws; the only three throws in that fuzz were hand-built ACCESSORS — a
// schema with a throwing `type` getter, a value with a throwing getter, and a
// Proxy whose `get`/`ownKeys` traps throw. A getter or a Proxy is not JSON:
// `JSON.parse` cannot construct one, so no caller on this path can reach that
// class. Totality against arbitrary JS objects would be a DIFFERENT function —
// it would have to read every member through accessors it cannot trust, and no
// rule below is written for that.
//
// THE WALK IS AN EXPLICIT FRAME LIST, never the JS call stack — dsh's house rule
// for untrusted input ("without using the JavaScript call stack"), and the T1
// review round measured why it is not merely a style: this walk raised
// RangeError at 3,600-3,700 nesting cold (~9,500 warm) while JSON.parse accepts
// >= 1,000,000, so the stack — not the input — was the binding constraint, and a
// RangeError is rethrown by the scheduler and kills the whole turn. That is the
// failure mode this unit exists to remove, so no rule below may recurse.
//
// Two rules run through every keyword read, and both are measured shapes:
//   · a keyword CARRYING `undefined` is ABSENT (§3.5 — plan-mode/src/index.ts:25
//     writes { type: "object", properties: undefined, required: undefined });
//   · a value member that is absent OR `undefined` is MISSING — the same rule,
//     one level down (and only an OWN member counts as a member at all).
// A keyword or type name outside this subset is not a constraint: the value
// layer checks what it recognizes and stays silent about the rest (§3.1), which
// is what makes it safe on a foreign schema.
//
// THE FILE HAS TWO LAYERS, and the difference is the load-bearing part of the
// design (§3.1): the value layer IGNORES a keyword it does not recognize — the
// right reading for a schema this repo did not write — while
// `assertSupportedJsonSchema` REJECTS it — the right reading for a schema this
// repo did write. Port the value layer alone and an unknown keyword is silently
// ignored, which is what the assertion layer exists to turn into a loud refusal.
// It runs once, at registration, and only for this repo's own declarations:
// `Tool.inputSchemaForeign` marks the schemas an MCP server forwards verbatim.

export interface JsonSchemaNode {
  type?: string | readonly string[]
  properties?: Record<string, JsonSchemaNode> | undefined
  required?: readonly string[] | undefined
  additionalProperties?: boolean | JsonSchemaNode | undefined
  items?: JsonSchemaNode | undefined
  enum?: readonly unknown[] | undefined
  minimum?: number | undefined
  maximum?: number | undefined
  maxItems?: number | undefined
  description?: string | undefined
}

/** One unit of work for the walk: either a value to validate against a schema,
 * or the deferred report of a closed object's undeclared members (deferred in a
 * frame so the violations still come out in document order — schemas' declared
 * members first, extras last — without recursing). */
type Frame =
  | { kind: "value"; schema: unknown; value: unknown; path: string }
  | { kind: "undeclared"; value: Record<string, unknown>; declared: Record<string, unknown> | undefined; path: string }

/** The lossless walk's frames. `exit` frames are what keep the cycle set
 * path-scoped: a node is untracked again the moment its subtree is finished. */
type LosslessFrame = { kind: "enter"; value: unknown } | { kind: "exit"; node: object }

/** Reports every violation of `value` against `schema`, each naming its path.
 * An empty array means the value conforms. This function never throws, never
 * coerces and never mutates — for any value against any schema. */
export function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path = "value"): string[] {
  const violations: string[] = []
  const frames: Frame[] = [{ kind: "value", schema, value, path }]
  const proven = new Set<object>() // the lossless memo, shared by the whole call — see isLosslessJson
  while (frames.length > 0) {
    const frame = frames.pop() as Frame
    if (frame.kind === "undeclared") reportUndeclaredMembers(frame, violations)
    else collectViolations(frame, frames, violations, proven)
  }
  return violations
}

// ——— the ASSERT layer (§3.1, §3.2) ————————————————————————————————————————————
//
// The ten keywords of the measured subset, in the order the violation message
// renders them. This list is this repo's CONTRACT WITH ITSELF: a declaration is
// rejected at the moment it is written, rather than a keyword it uses being
// silently ignored on every call. It is deliberately NOT dsh's list — the two
// subsets contain each other in neither direction (§1.4) — and it is the same
// list the value layer recognizes, minus the §3.1 tolerance.
const SUPPORTED_KEYWORDS: readonly string[] = [
  "additionalProperties",
  "description",
  "enum",
  "items",
  "maximum",
  "maxItems",
  "minimum",
  "properties",
  "required",
  "type",
]

/** One unit of work for the assertion walk: a node, and the path naming it. */
type SchemaFrame = { node: unknown; path: string }

/** Thrown by `assertSupportedJsonSchema` for a schema outside the subset: ONE
 * error carrying EVERY violation, so an author sees the whole repair at once
 * (dsh's typed-violation shape, one layer up). `code` is the disposition other
 * layers match on; the message is for the human. */
export class JsonSchemaError extends Error {
  readonly code = "UNSUPPORTED_SCHEMA"
  constructor(readonly violations: readonly string[]) {
    super(`unsupported schema: ${violations.join("; ")}`)
    this.name = "JsonSchemaError"
  }
}

/** §3.1's assert layer: a schema this repo wrote must stay inside the measured
 * subset, so this walk rejects every keyword the value layer would silently
 * ignore. Throws one typed error naming all of them; returns otherwise.
 *
 * The subset has TWO halves, and both are checked here: WHICH keywords exist
 * (§3.2), and WHAT SHAPE each one's value has. The second half is not
 * formalism — a keyword on the list carrying the wrong value passes a
 * keyword-only check and then degrades validation silently, because the value
 * layer reads what it is given (`properties` goes to `Object.entries`, a
 * non-finite bound compares false forever). It is the NAME side the check
 * deliberately does not police: an unknown type name stays legal (§3.1), since
 * a remote schema brings types this repo does not have.
 *
 * TOTAL in the assertion layer's sense: any input at all either returns or
 * raises THAT error — a schema that is not an object is a violation, not a
 * TypeError from reading keywords off it. It also follows the file's two rules
 * on every keyword read: a keyword CARRYING `undefined` is ABSENT (§3.5), and
 * the walk is an explicit frame list, never the JS call stack. */
export function assertSupportedJsonSchema(schema: unknown): asserts schema is JsonSchemaNode {
  const violations = collectSchemaViolations(schema)
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

/** What shape each supported keyword's value must have, rendered as the clause
 * that completes `"<path>.<key>"` in the message. `undefined` means the value
 * has the one shape this keyword accepts.
 *
 * The string arms mirror the value layer's own reads exactly: a `type` array
 * must be NON-EMPTY (an empty one constrains nothing, which is a declaration
 * mistake, not a style choice), `enum` must be non-empty for the same reason,
 * and the three bounds must be FINITE.
 *
 * WHY the finiteness rule, per value — the three are NOT the same (measured
 * against the value layer, one probe each): `minimum: NaN` and `maximum: NaN`
 * never fire (every comparison against NaN is false), and the two saturating
 * forms `minimum: -Infinity` / `maximum: Infinity` never fire either — but
 * `minimum: Infinity` reports `"value" must be >= Infinity` and
 * `maximum: -Infinity` reports `"value" must be <= -Infinity`, i.e. they refuse
 * EVERY finite value. So a non-finite bound is either a typo that silently
 * does nothing or a constraint that rejects its whole domain, and never what
 * its author meant. (An earlier version of this comment claimed the whole
 * ±Infinity family "never fires"; the two rejecting arms are the correction.) */
function shapeClause(key: string, carried: unknown): string | undefined {
  switch (key) {
    case "type":
      if (typeof carried === "string") return undefined
      if (Array.isArray(carried) && carried.length > 0 && carried.every((name) => typeof name === "string")) return undefined
      return "must be a string or a non-empty array of strings"
    case "properties":
      return isRecord(carried) ? undefined : "must be an object of schemas"
    case "required":
      return Array.isArray(carried) && carried.every((name) => typeof name === "string") ? undefined : "must be an array of strings"
    case "additionalProperties":
      return typeof carried === "boolean" || isRecord(carried) ? undefined : "must be a boolean or a schema"
    case "items":
      return isRecord(carried) ? undefined : "must be a schema"
    case "enum":
      return Array.isArray(carried) && carried.length > 0 ? undefined : "must be a non-empty array"
    case "minimum":
    case "maximum":
    case "maxItems":
      return typeof carried === "number" && Number.isFinite(carried) ? undefined : "must be a finite number"
    case "description":
      return typeof carried === "string" ? undefined : "must be a string"
    default:
      // Unreachable for the ten keywords above; a keyword added to the list
      // without a rule here would be checked by the keyword half alone, which is
      // where the assert layer stood before this function existed.
      return undefined
  }
}

/** The walk behind `assertSupportedJsonSchema`. Short of the value layer it has
 * no value to bottom out against, so it memoises the nodes it has read: a
 * subschema pointing at itself (a JS object graph can; a JSON literal cannot)
 * would otherwise never finish, and a shared subschema would be re-reported once
 * per path. */
function collectSchemaViolations(root: unknown): string[] {
  const violations: string[] = []
  const frames: SchemaFrame[] = [{ node: root, path: "schema" }]
  const walked = new Set<object>()
  while (frames.length > 0) {
    const frame = frames.pop() as SchemaFrame
    const { node, path } = frame
    if (!isRecord(node)) {
      // Nothing here carries keywords, so the whole node is the violation.
      violations.push(`"${path}" must be a schema object`)
      continue
    }
    if (walked.has(node)) continue
    walked.add(node)
    // Keys are read in REVERSE so the subschema frames pop in document order
    // (the value layer's rule for its own frames); the node's own violations
    // are held aside and appended in reverse for the same reason, which makes
    // the message's order the schema's order, parents before children.
    const own: string[] = []
    for (const key of Object.keys(node).reverse()) {
      const carried = ownMember(node, key)
      if (carried === undefined) continue // §3.5: a keyword CARRYING `undefined` is ABSENT
      if (!SUPPORTED_KEYWORDS.includes(key)) {
        own.push(`"${path}.${key}" is not a supported keyword (subset: ${SUPPORTED_KEYWORDS.join(", ")})`)
        continue
      }
      const shape = shapeClause(key, carried)
      if (shape !== undefined) {
        // Reported and NOT descended into: the value is not a schema graph, so
        // a second message about its members would only bury the first.
        own.push(`"${path}.${key}" ${shape}`)
        continue
      }
      // The three keyword positions that carry a subschema. `properties` carries
      // a MAP of them, `items` one, and `additionalProperties` a boolean OR a
      // schema (§3.6.1); nothing else in the subset descends. The shape check
      // above has already established which of them is a record here.
      if (key === "properties") {
        for (const name of Object.keys(carried as Record<string, unknown>).reverse()) {
          const child = ownMember(carried as Record<string, unknown>, name)
          if (child === undefined) continue // absent, one level down (§3.5)
          frames.push({ node: child, path: `${path}.properties.${name}` })
        }
      } else if (key === "items") {
        frames.push({ node: carried, path: `${path}.items` })
      } else if (key === "additionalProperties" && isRecord(carried)) {
        frames.push({ node: carried, path: `${path}.additionalProperties` })
      }
    }
    violations.push(...own.reverse())
  }
  return violations
}

// `schema` is taken as `unknown` past the entry point: a foreign schema is not
// this repo's data, and every keyword read below must survive a shape nobody
// promised (a null subschema, `items: true`, `required: "path"`).
function collectViolations(frame: Extract<Frame, { kind: "value" }>, frames: Frame[], out: string[], proven: Set<object>): void {
  const { schema, value, path } = frame
  if (!isRecord(schema)) return // a schema that is not an object declares nothing

  const declaredType = schema.type
  if (declaredType !== undefined) {
    const mismatch = typeMismatch(declaredType, value, path)
    if (mismatch !== undefined) {
      // The value is not of the declared type, so its members are not this
      // schema's business — reporting them too would only bury the message.
      out.push(mismatch)
      return
    }
  }

  const allowed = schema.enum
  if (Array.isArray(allowed) && !allowed.some((member) => isSameJsonValue(member, value))) {
    out.push(`"${path}" must be one of ${renderEnum(allowed)}`)
  }

  if (typeof value === "number") {
    // Bounds apply to JSON numbers only: `undefined`-valued keywords are
    // absent, and a NaN bound is not a JSON number either.
    const minimum = schema.minimum
    if (typeof minimum === "number" && value < minimum) out.push(`"${path}" must be >= ${minimum}`)
    const maximum = schema.maximum
    if (typeof maximum === "number" && value > maximum) out.push(`"${path}" must be <= ${maximum}`)
  }

  if (isRecord(value)) {
    if (!isLosslessJson(value, proven)) {
      out.push(`"${path}" must be a lossless JSON object`)
      return
    }
    collectObjectMembers(schema, value, path, frames, out)
    return
  }

  if (Array.isArray(value)) {
    if (!isLosslessJson(value, proven)) {
      out.push(`"${path}" must be a dense lossless JSON array`)
      return
    }
    const maxItems = schema.maxItems
    if (typeof maxItems === "number" && value.length > maxItems) {
      out.push(`"${path}" must have at most ${maxItems} items`)
    }
    const items = schema.items
    if (items !== undefined) {
      // Pushed in reverse so the stack pops them in index order.
      for (let i = value.length - 1; i >= 0; i--) frames.push({ kind: "value", schema: items, value: value[i], path: `${path}[${i}]` })
    }
  }
}

function collectObjectMembers(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  frames: Frame[],
  out: string[],
): void {
  const properties = isRecord(schema.properties) ? schema.properties : undefined

  const required = schema.required
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && ownMember(value, key) === undefined) out.push(`missing required property "${path}.${key}"`)
    }
  }

  // Queued in reverse of report order: undeclared members are pushed FIRST so
  // they pop after every declared member's subtree, which is where the walk
  // reported them before it became a frame list.
  const additional = schema.additionalProperties
  if (additional === false) {
    frames.push({ kind: "undeclared", value, declared: properties, path })
  } else if (isRecord(additional)) {
    for (const key of Object.keys(value).reverse()) {
      const member = ownMember(value, key)
      if (member === undefined) continue // absent, by the rule below
      if (properties !== undefined && Object.prototype.hasOwnProperty.call(properties, key)) continue
      frames.push({ kind: "value", schema: additional, value: member, path: `${path}.${key}` })
    }
  }

  if (properties !== undefined) {
    for (const key of Object.keys(properties).reverse()) {
      const childSchema = properties[key]
      const member = ownMember(value, key)
      // An `undefined`-valued child schema declares nothing, and a member that
      // is absent or `undefined` is missing — reported above if it is required.
      if (childSchema === undefined || member === undefined) continue
      frames.push({ kind: "value", schema: childSchema, value: member, path: `${path}.${key}` })
    }
  }
}

function reportUndeclaredMembers(frame: Extract<Frame, { kind: "undeclared" }>, out: string[]): void {
  for (const key of Object.keys(frame.value)) {
    if (ownMember(frame.value, key) === undefined) continue // absent, by the rule above
    if (frame.declared !== undefined && Object.prototype.hasOwnProperty.call(frame.declared, key)) continue
    out.push(`"${frame.path}.${key}" is not a declared property (additionalProperties: false)`)
  }
}

/** Own-member read. A member inherited from the prototype chain is not a member
 * of this JSON value (`toString` is not a declared property of `{}`), and a
 * member carrying `undefined` is absent (§3.5, one level down). */
function ownMember(target: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined
}

function typeMismatch(declared: unknown, value: unknown, path: string): string | undefined {
  if (typeof declared === "string") {
    return matchesType(declared, value) ? undefined : `"${path}" must be ${typeClause(declared)}`
  }
  if (!Array.isArray(declared)) return undefined // a shape we do not recognize constrains nothing
  const names = declared.filter((name): name is string => typeof name === "string")
  if (names.length === 0) return undefined
  if (names.some((name) => matchesType(name, value))) return undefined
  return `"${path}" must be one of ${names.map((name) => `"${name}"`).join(", ")}`
}

function matchesType(name: string, value: unknown): boolean {
  switch (name) {
    case "string":
      return typeof value === "string"
    case "number":
      return isJsonNumber(value)
    case "integer":
      return isJsonNumber(value) && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "object":
      return isRecord(value)
    case "array":
      return Array.isArray(value)
    case "null":
      return value === null
    // A type name outside the measured set is not a constraint — the §3.1 rule
    // applied to a name instead of a keyword. (`null` is the one addition: a
    // foreign `type: ["string","null"]` must constrain what it names, and a
    // type array whose every arm is unrecognized would constrain nothing.)
    default:
      return true
  }
}

function typeClause(name: string): string {
  switch (name) {
    case "string":
      return "a string"
    case "number":
      return "a finite JSON number"
    case "integer":
      return "an integer"
    case "boolean":
      return "a boolean"
    case "object":
      return "a lossless JSON object"
    case "array":
      return "a dense lossless JSON array"
    case "null":
      return "null"
    default:
      return `a ${name}`
  }
}

function isJsonNumber(value: unknown): value is number {
  // §3.3, CORRECTED 2026-09-21 — the two exclusions have DIFFERENT reasons, and
  // an earlier version of this comment gave -0 the wrong one ("a JSON number is
  // FINITE, and -0 is not one"): measured, `JSON.parse('-0')` IS -0, so JSON
  // expresses it perfectly well. What -0 fails is ROUND-TRIPPING —
  // `JSON.stringify(-0)` is `"0"` — and losslessness is the property this walk
  // is about, so -0 is rejected as not-carried, not as not-expressible.
  // NaN and ±Infinity are the expressibility case: no JSON spelling exists for
  // them at all. Object.is keeps -0's sign out of the set.
  return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `enum` membership is JSON equality: key ORDER is not part of a JSON value, so
 * two structures compare by their key SETS (fix round 1 measured the old
 * `JSON.stringify` comparison falsely reporting `{b:2,a:1}` against
 * `{enum:[{a:1,b:2}]}`). Scalars compare by identity, so -0 is not 0 (§3.3).
 * Both sides must first be lossless JSON: that is what forbids cycles, which is
 * what lets the pair walk below keep its own stack instead of the JS one. */
function isSameJsonValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false
  // A member that is not lossless JSON equals nothing but itself (recorded, not
  // fixed — review round 2, Low): two DISTINCT `new Map()`s are unequal here,
  // where the old JSON-text comparison called both "{}" and reported only the
  // lossless violation. Message-only, unpinned, and the honest reading.
  if (!isLosslessJson(a, new Set()) || !isLosslessJson(b, new Set())) return false
  const pairs: Array<[unknown, unknown]> = [[a, b]]
  while (pairs.length > 0) {
    const [x, y] = pairs.pop() as [unknown, unknown]
    if (Object.is(x, y)) continue
    if (typeof x !== "object" || x === null || typeof y !== "object" || y === null) return false
    if (Array.isArray(x) !== Array.isArray(y)) return false
    if (Array.isArray(x) && Array.isArray(y)) {
      if (x.length !== y.length) return false
      for (let i = 0; i < x.length; i++) pairs.push([x[i], y[i]])
      continue
    }
    const keys = Object.keys(x)
    if (keys.length !== Object.keys(y).length) return false
    for (const key of keys) {
      // A key missing on the other side, whatever its order: same key SETS.
      if (!Object.prototype.hasOwnProperty.call(y, key)) return false
      pairs.push([(x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key]])
    }
  }
  return true
}

function renderEnum(allowed: readonly unknown[]): string {
  try {
    return JSON.stringify(allowed)
  } catch {
    return "[...]" // a cycle or a BigInt has no JSON text (and stringify itself
    // is bounded by the JS stack); the message still names the path
  }
}

/** True when `value` survives JSON.stringify/parse unchanged: every member is a
 * JSON value, arrays are dense, and no member is dropped (symbol keys,
 * non-enumerable keys, class instances, cycles).
 *
 * `proven` memoises the nodes already verified WHOLE, and it is what keeps a
 * deep DECLARED descent linear: the top call verifies every node in the tree, so
 * each descendant's re-check is an O(1) hit instead of a re-walk of its whole
 * subtree (without it the walk is quadratic in a deep value's depth — the same
 * "the walk is the binding constraint" defect on a different axis). */
function isLosslessJson(root: unknown, proven: Set<object>): boolean {
  const frames: LosslessFrame[] = [{ kind: "enter", value: root }]
  const onPath = new Set<object>()
  while (frames.length > 0) {
    const frame = frames.pop() as LosslessFrame
    if (frame.kind === "exit") {
      onPath.delete(frame.node)
      proven.add(frame.node)
      continue
    }
    const value = frame.value
    if (value === null || typeof value === "string" || typeof value === "boolean") continue
    if (typeof value === "number") {
      if (!isJsonNumber(value)) return false
      continue
    }
    if (typeof value !== "object") return false // undefined, function, symbol, bigint
    const node = value
    if (proven.has(node)) continue
    if (onPath.has(node)) return false // a cycle: JSON has no references
    if (Array.isArray(node)) {
      // A hole and an `undefined` entry are the same loss, and so is an extra
      // property: JSON arrays are dense and carry indices only.
      if (Object.keys(node).length !== node.length) return false
      onPath.add(node)
      frames.push({ kind: "exit", node })
      for (const item of node) frames.push({ kind: "enter", value: item })
      continue
    }
    const proto = Object.getPrototypeOf(node)
    if (proto !== null && proto !== Object.prototype) return false // Date/Map/Set/class
    if (Object.getOwnPropertySymbols(node).length > 0) return false // JSON drops these
    if (Object.getOwnPropertyNames(node).length !== Object.keys(node).length) return false // ...and non-enumerables
    onPath.add(node)
    frames.push({ kind: "exit", node })
    for (const member of Object.values(node)) {
      if (member === undefined) continue // an `undefined` member is absent (§3.5)
      frames.push({ kind: "enter", value: member })
    }
  }
  return true
}
