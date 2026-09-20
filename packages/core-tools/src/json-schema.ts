// The SUBSET is measured, not copied — spec §3.2. IH's 61 literal declarations
// use exactly these keywords (counts in the spec), and a verbatim port of dsh's
// validator would both reject three constructs IH legitimately writes and lack
// three IH uses. The two subsets contain each other in neither direction.
// (§3.6.1 is the one branch the measurement forced after §3.6 was written:
// `additionalProperties` is a BOOLEAN *or* a SCHEMA — workflow/src/tool.ts:73
// declares a map of name→string with the schema form.)
//
// THE ONE PROPERTY THAT MATTERS: this function is TOTAL. It reports, it never
// throws, and it never coerces — for arbitrary values against arbitrary
// schemas. That is the whole reason it can run on a schema this repo did not
// write (MCP forwards the remote server's schema verbatim, mcp-client/bridge.ts).
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
  // §3.3: a JSON number is FINITE, and -0 is not one — Object.is keeps its sign.
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
