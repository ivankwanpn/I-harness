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
// Two rules run through every keyword read, and both are measured shapes:
//   · a keyword CARRYING `undefined` is ABSENT (§3.5 — plan-mode/src/index.ts:25
//     writes { type: "object", properties: undefined, required: undefined });
//   · a value member that is absent OR `undefined` is MISSING — the same rule,
//     one level down (the value side of §3.3).
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

/** Reports every violation of `value` against `schema`, each naming its path.
 * An empty array means the value conforms. This function never throws, never
 * coerces and never mutates — for any value against any schema. */
export function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path = "value"): string[] {
  const violations: string[] = []
  collectViolations(schema, value, path, violations)
  return violations
}

// `schema` is taken as `unknown` past the entry point: a foreign schema is not
// this repo's data, and every keyword read below must survive a shape nobody
// promised (a null subschema, `items: true`, `required: "path"`).
function collectViolations(schema: unknown, value: unknown, path: string, out: string[]): void {
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
    if (!isLosslessJson(value, new Set())) {
      out.push(`"${path}" must be a lossless JSON object`)
      return
    }
    collectObjectViolations(schema, value, path, out)
    return
  }

  if (Array.isArray(value)) {
    if (!isLosslessJson(value, new Set())) {
      out.push(`"${path}" must be a dense lossless JSON array`)
      return
    }
    const maxItems = schema.maxItems
    if (typeof maxItems === "number" && value.length > maxItems) {
      out.push(`"${path}" must have at most ${maxItems} items`)
    }
    const items = schema.items
    if (items !== undefined) {
      for (let i = 0; i < value.length; i++) collectViolations(items, value[i], `${path}[${i}]`, out)
    }
  }
}

function collectObjectViolations(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  out: string[],
): void {
  const properties = isRecord(schema.properties) ? schema.properties : undefined

  const required = schema.required
  if (Array.isArray(required)) {
    for (const key of required) {
      if (typeof key === "string" && value[key] === undefined) out.push(`missing required property "${path}.${key}"`)
    }
  }

  if (properties !== undefined) {
    for (const [key, childSchema] of Object.entries(properties)) {
      const member = value[key]
      // An `undefined`-valued child schema declares nothing, and a member that
      // is absent or `undefined` is missing — reported above if it is required.
      if (childSchema === undefined || member === undefined) continue
      collectViolations(childSchema, member, `${path}.${key}`, out)
    }
  }

  const additional = schema.additionalProperties
  if (additional === false || isRecord(additional)) {
    for (const key of Object.keys(value)) {
      const member = value[key]
      if (member === undefined) continue // absent, by the rule above
      if (properties !== undefined && Object.prototype.hasOwnProperty.call(properties, key)) continue
      if (additional === false) {
        out.push(`"${path}.${key}" is not a declared property (additionalProperties: false)`)
      } else {
        collectViolations(additional, member, `${path}.${key}`, out)
      }
    }
  }
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

function isSameJsonValue(a: unknown, b: unknown): boolean {
  // `enum` membership is JSON equality: scalars by identity (so -0 is not 0,
  // keeping §3.3 consistent), structures by their JSON text.
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false // a cycle or a BigInt has no JSON text; it equals nothing
  }
}

function renderEnum(allowed: readonly unknown[]): string {
  try {
    return JSON.stringify(allowed)
  } catch {
    return "[...]" // same reason; the message still names the path
  }
}

/** True when `value` survives JSON.stringify/parse unchanged: every member is a
 * JSON value, arrays are dense, and no member is dropped (symbol keys,
 * non-enumerable keys, class instances, cycles). */
function isLosslessJson(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return isJsonNumber(value)
  if (typeof value !== "object") return false // undefined, function, symbol, bigint
  const node = value as object
  if (seen.has(node)) return false // a cycle: JSON has no references
  seen.add(node)
  try {
    if (Array.isArray(node)) {
      // A hole and an `undefined` entry are the same loss, and so is an extra
      // property: JSON arrays are dense and carry indices only.
      if (Object.keys(node).length !== node.length) return false
      for (const item of node) if (!isLosslessJson(item, seen)) return false
      return true
    }
    const proto = Object.getPrototypeOf(node)
    if (proto !== null && proto !== Object.prototype) return false // Date/Map/Set/class
    if (Object.getOwnPropertySymbols(node).length > 0) return false // JSON drops these
    if (Object.getOwnPropertyNames(node).length !== Object.keys(node).length) return false // ...and non-enumerables
    for (const member of Object.values(node)) {
      if (member === undefined) continue // an `undefined` member is absent (§3.5)
      if (!isLosslessJson(member, seen)) return false
    }
    return true
  } finally {
    seen.delete(node)
  }
}
