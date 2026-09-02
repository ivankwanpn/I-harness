/**
 * Section descriptors (追加式) for the settings document.
 *
 * The section protocol layers on top of the existing single-file SettingsStore:
 * each section (`llm`, `onboarding`) is a subtree of the document described by
 * a lightweight type-driven schema. `describeSection` returns redacted views
 * for the UI; `mutateSection` applies field-validated patch ops under an
 * expected-revision guard — a mismatch throws SettingsConflictError and the
 * caller refetches and replays (409 → reload/replay, the repo's prefs stance).
 *
 * Pure module — no fs access, no store construction. The store is injected so
 * this file stays dependency-free against packages/settings itself (only the
 * SettingsStore/Settings types are imported, type-only, no runtime cycle).
 *
 * @module @i-harness/settings/sections
 */

import type { SettingsLlm, SettingsOnboarding, SettingsProviderConfig, SettingsStoreSurface } from "./index.ts"

/** The top-level section keys the section protocol knows about. */
export type SectionName = "llm" | "onboarding"

/** How a field's value is surfaced by describe. */
export type FieldRole = "value" | "secret" | "credential-ref"

/** Lightweight field type lattice. `array`/`object` extend the scalar plan
 * types so the `llm.providers.<route>` map and `models[]` lists are describable. */
export type FieldType = "string" | "number" | "boolean" | "enum" | "array" | "object"

export interface FieldSpec {
  type: FieldType
  /** Redaction: secret → "***" in views; credential-ref → the ref NAME is a
   * configuration value (not a secret) and is preserved as-is. */
  role?: FieldRole
  /** Closed value set for type "enum". */
  enum?: string[]
  /** Extra validation returning a failure message or undefined when valid. */
  validate?: (v: unknown) => string | undefined
  /** Fixed child fields for type "object". */
  fields?: Record<string, FieldSpec>
  /** Required child keys for type "object" with `fields` (enforced at mutate —
   * e.g. a model row's addressable `id`). */
  required?: readonly string[]
  /** Element spec for type "array"; for a property-style "object" (dynamic
   * keys, e.g. provider routes) describes each entry's value instead. */
  items?: FieldSpec
}

export interface SectionSchema {
  fields: Record<string, FieldSpec>
}

export interface SectionView {
  /** Effective merged view (base ⊕ user), role-redacted. */
  value: Record<string, unknown>
  /** Adapter static defaults (llm only; absent for sections without a base). */
  base?: Record<string, unknown>
  /** What is actually stored (role-redacted). */
  user?: Record<string, unknown>
  /** Monotonic per-section counter; 0 = never mutated since this counter track. */
  revision: number
  writable: true
}

export type SectionOp =
  | { op: "set"; path: string[]; value: unknown }
  | { op: "unset"; path: string[] }

/** Revision-guard failure: the caller's expectedRevision is stale. */
export class SettingsConflictError extends Error {
  readonly code = "settings-section-conflict" as const
  readonly expected: number
  readonly actual: number
  constructor(expected: number, actual: number) {
    super(`settings section changed elsewhere: expected revision ${expected}, actual ${actual}`)
    this.name = "SettingsConflictError"
    this.expected = expected
    this.actual = actual
  }
}

/** Field/path validation failure before any write. */
export class SettingsValidationError extends Error {
  readonly code = "settings-section-validation" as const
  constructor(message: string) {
    super(message)
    this.name = "SettingsValidationError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Closed set for llm.defaultModel.reasoningEffort (validated at mutate time). */
const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const

/**
 * Closed set of provider wire protocols (D2 — explicit dropdown):
 * `openai-completions` → llm-openai-compatible, `openai-responses` →
 * llm-openai, `anthropic-messages` → llm-anthropic, `gemini` → llm-gemini,
 * `bedrock` → llm-bedrock (M30 first-class providers). The runtime enum
 * lives HERE (not index.ts) because the section schema needs the runtime
 * list while sections.ts stays type-only against index.ts (no runtime cycle).
 */
export const PROVIDER_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages", "gemini", "bedrock"] as const

/** The wire protocol of one llm.providers.<route> entry. */
export type SettingsProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number]

/** Fill-in when a stored/raw protocol is absent or invalid (normalize level). */
export const DEFAULT_PROVIDER_PROTOCOL: SettingsProviderProtocol = "openai-completions"

/** FieldSpec-level check: contextWindow/maxTokens must be positive integers. */
function positiveInteger(value: unknown): string | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? undefined
    : "expected a positive integer"
}

/** One model row: `id` is required (the addressable key); the rest are optional
 * UI/discovery hints (D5 objectification). */
const MODEL_FIELDS: Record<string, FieldSpec> = {
  id: { type: "string" },
  name: { type: "string" },
  contextWindow: { type: "number", validate: positiveInteger },
  maxTokens: { type: "number", validate: positiveInteger },
}

const providerConfigFields: Record<string, FieldSpec> = {
  apiKeyEnv: { type: "string", role: "credential-ref" },
  baseURL: { type: "string" },
  displayName: { type: "string" },
  protocol: { type: "enum", enum: [...PROVIDER_PROTOCOLS] },
  models: { type: "array", items: { type: "object", fields: MODEL_FIELDS, required: ["id"] } },
}

/** Default schemas for the readable sections (sections() 預設 schema). */
export const SECTION_SCHEMAS: Record<SectionName, SectionSchema> = {
  llm: {
    fields: {
      providers: {
        type: "object",
        items: { type: "object", fields: providerConfigFields },
      },
      defaultModel: {
        type: "object",
        fields: {
          provider: { type: "string" },
          model: { type: "string" },
          reasoningEffort: { type: "enum", enum: [...REASONING_EFFORTS] },
        },
      },
    },
  },
  onboarding: {
    fields: { welcomeNoticeVersion: { type: "string" } },
  },
}

/** Seed route → wire protocol map. Amendment (seeded defaults removed): every
 * provider is settings-managed — the map is EMPTY by design. The export stays
 * so the resolver chain keeps its shape
 * `user section value > SEEDED_PROTOCOLS[route] > DEFAULT_PROVIDER_PROTOCOL`
 * (see resolveProviderProtocol): a seed simply never matches, so ANY route
 * without an explicit user protocol resolves to DEFAULT_PROVIDER_PROTOCOL. */
export const SEEDED_PROTOCOLS: Record<string, SettingsProviderProtocol> = {}

/**
 * Provider protocol resolution chain: user section value > seeded default
 * > generic default. The user value comes from a NORMALIZED config (valid
 * or absent — normalizeSettings never stores invalid); a non-valid user
 * value (raw caller) falls through to the default (read-tolerant).
 * @param route the provider route/key of llm.providers.<route>
 * @param user the route's (normalized) user config, if present
 */
export function resolveProviderProtocol(
  route: string,
  user?: SettingsProviderConfig,
): SettingsProviderProtocol {
  const raw = user?.protocol
  if (raw !== undefined && (PROVIDER_PROTOCOLS as readonly string[]).includes(raw)) return raw
  return SEEDED_PROTOCOLS[route] ?? DEFAULT_PROVIDER_PROTOCOL
}

/**
 * The section's static `base` layer. Amendment (seeded defaults removed): the
 * built-in provider seed rows are GONE — there is nothing to render before the
 * user configures anything, so the base providers map stays EMPTY (an empty
 * base still keeps describeSection's merge wiring exact — the value layer
 * becomes user-only). The `base` field survives on the wire for shape
 * stability; it never carries a provider row again.
 */
const sectionBase: Partial<Record<SectionName, Record<string, unknown>>> = {
  llm: { providers: {} },
}

/** The base layer for a section (its static defaults), if it has one. */
export function sectionBaseOf(name: SectionName): Record<string, unknown> | undefined {
  return sectionBase[name]
}

// ---- redaction -------------------------------------------------------------

const DROP = Symbol("drop")

/** Apply role-based redaction to a value against a schema. `secret` fields
 * become the "***" placeholder (the value must never leave the process);
 * `credential-ref` fields keep their ref name (the reference itself is the
 * configuration, packages/credentials holds and never describes the value).
 * Values that do not match their FieldSpec type are dropped from the view. */
export function redactForSchema(schema: SectionSchema, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  return redactRecord(schema.fields, value) as Record<string, unknown>
}

function isRedactable(spec: FieldSpec, raw: unknown): boolean {
  switch (spec.type) {
    case "string": return typeof raw === "string"
    case "number": return typeof raw === "number" && Number.isFinite(raw)
    case "boolean": return typeof raw === "boolean"
    case "enum": return typeof raw === "string" && (spec.enum ?? []).includes(raw)
    case "array": return Array.isArray(raw)
    case "object": return isRecord(raw)
  }
}

function redactRecord(fields: Record<string, FieldSpec>, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    const spec = fields[key]
    if (spec === undefined) continue // unknown keys are not describe-describable
    const redacted = redactNode(spec, raw)
    if (redacted !== DROP) out[key] = redacted
  }
  return out
}

function redactNode(spec: FieldSpec, raw: unknown): unknown {
  switch (spec.type) {
    case "object": {
      if (!isRecord(raw)) return DROP
      if (spec.fields !== undefined) return redactRecord(spec.fields, raw)
      if (spec.items !== undefined) {
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(raw)) {
          const redacted = redactNode(spec.items, value)
          if (redacted !== DROP) out[key] = redacted
        }
        return out
      }
      return raw
    }
    case "array": {
      if (!Array.isArray(raw)) return DROP
      if (spec.items === undefined) return raw
      const out: unknown[] = []
      for (const value of raw) {
        const redacted = redactNode(spec.items, value)
        if (redacted !== DROP) out.push(redacted)
      }
      return out
    }
    default:
      if (!isRedactable(spec, raw)) return DROP
      if (spec.role === "secret") return "***" // placeholder — never the value
      return raw // includes credential-ref: the ref name is preserved
  }
}

// ---- describe --------------------------------------------------------------

/** Deep-merge user content over the base layer (user wins per key). */
function deepMerge(base: unknown, user: unknown): unknown {
  if (isRecord(base) && isRecord(user)) {
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(user)) {
      out[key] = key in out ? deepMerge(out[key], value) : value
    }
    return out
  }
  return user
}

/** Describe one section for the UI: merged redacted view + base + user layers. */
export function describeSection(name: SectionName, store: SettingsStoreSurface): SectionView {
  const schema = SECTION_SCHEMAS[name]
  const stored = store.get()[name] as unknown as Record<string, unknown>
  const base = sectionBase[name]
  const view: SectionView = {
    value: redactForSchema(schema, base !== undefined ? deepMerge(base, stored) : stored),
    revision: store.getSectionRevision(name),
    writable: true,
  }
  if (base !== undefined) view.base = redactForSchema(schema, base)
  view.user = redactForSchema(schema, stored)
  return view
}

// ---- mutate ----------------------------------------------------------------

function describeType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function validateValue(spec: FieldSpec, value: unknown, where: string): void {
  const custom = spec.validate?.(value)
  if (custom !== undefined) throw new SettingsValidationError(`${where}: ${custom}`)
  switch (spec.type) {
    case "string":
      if (typeof value !== "string" || value === "") {
        throw new SettingsValidationError(`${where}: expected non-empty string, got ${describeType(value)}`)
      }
      return
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new SettingsValidationError(`${where}: expected finite number, got ${describeType(value)}`)
      }
      return
    case "boolean":
      if (typeof value !== "boolean") {
        throw new SettingsValidationError(`${where}: expected boolean, got ${describeType(value)}`)
      }
      return
    case "enum":
      if (typeof value !== "string" || !(spec.enum ?? []).includes(value)) {
        throw new SettingsValidationError(`${where}: expected one of [${(spec.enum ?? []).join(", ")}], got ${describeType(value)}`)
      }
      return
    case "array": {
      if (!Array.isArray(value)) {
        throw new SettingsValidationError(`${where}: expected array, got ${describeType(value)}`)
      }
      if (spec.items !== undefined) {
        value.forEach((v, index) => validateValue(spec.items as FieldSpec, v, `${where}[${index}]`))
      }
      return
    }
    case "object": {
      if (!isRecord(value)) {
        throw new SettingsValidationError(`${where}: expected object, got ${describeType(value)}`)
      }
      if (spec.fields !== undefined) {
        for (const [key, v] of Object.entries(value)) {
          const child = spec.fields[key]
          if (child === undefined) throw new SettingsValidationError(`${where}.${key}: unknown field`)
          validateValue(child, v, `${where}.${key}`)
        }
        for (const key of spec.required ?? []) {
          if (!(key in value)) throw new SettingsValidationError(`${where}.${key}: required field`)
        }
      } else if (spec.items !== undefined) {
        for (const [key, v] of Object.entries(value)) validateValue(spec.items, v, `${where}.${key}`)
      }
      return
    }
  }
}

/** Resolve the child spec for `seg` under `containerSpec`: a fixed field when
 * the container has `fields`, otherwise a dynamic map key (`items`). */
function childSpecFor(containerSpec: FieldSpec, seg: string): FieldSpec {
  const fixed = containerSpec.fields?.[seg]
  if (fixed !== undefined) return fixed
  if (containerSpec.items !== undefined) return containerSpec.items
  throw new SettingsValidationError(`unknown field "${seg}"`)
}

/** A `Record` or a JS array — both are valid intermediate containers. */
type SectionContainer = Record<string, unknown> | unknown[]

function isArrayKey(seg: string): boolean {
  return /^\d+$/.test(seg)
}

/** Set a path segment's value: arrays take a canonical index (append or
 * in-place — never a hole, so no sparse arrays can silently collapse at
 * normalize time), plain objects take any key. */
function setIn(parent: SectionContainer, key: string, value: unknown, where: string): void {
  if (Array.isArray(parent)) {
    if (!isArrayKey(key)) throw new SettingsValidationError(`${where}: expected array index, got "${key}"`)
    const index = Number(key)
    if (index > parent.length) {
      throw new SettingsValidationError(`${where}: array index ${index} out of bounds (length ${parent.length})`)
    }
    parent[index] = value
    return
  }
  parent[key] = value
}

/** Remove a path segment's value: object keys are deleted, array elements are
 * spliced (no holes). Returns false when nothing was removed — a no-op that
 * must not bump the revision. */
function unsetIn(parent: SectionContainer, key: string, where: string): boolean {
  if (Array.isArray(parent)) {
    if (!isArrayKey(key)) throw new SettingsValidationError(`${where}: expected array index, got "${key}"`)
    const index = Number(key)
    if (index >= parent.length) return false
    parent.splice(index, 1)
    return true
  }
  if (!(key in parent)) return false
  delete parent[key]
  return true
}

/**
 * Walk to the parent node of the final path segment.
 *
 * - With create=true a missing container is materialized IN THE SHAPE THE
 *   DECLARED SPEC SAYS (object → {}, array → []) — the reviewed bug used to
 *   fabricate `{}` for an array-typed node such as `providers.<route>.models`,
 *   which normalizeProviderConfig then silently dropped while the revision
 *   counter still bumped. Descending into a leaf-typed field is invalid.
 * - With create=false a missing container returns null and the op is a no-op
 *   (unset ops — unsetting something that has never existed must not fabricate
 *   content).
 * - Arrays are valid containers; their path segments must be canonical indices
 *   in bounds.
 *
 * `containerSpec` is the spec of the PARENT node; the terminal key's own spec
 * is resolved by the caller (childSpecFor) so a leaf field validates against
 * its own type, not the container's.
 */
function locateParent(
  schema: SectionSchema,
  root: Record<string, unknown>,
  path: string[],
  create: true,
): { parent: SectionContainer; key: string; containerSpec: FieldSpec }
function locateParent(
  schema: SectionSchema,
  root: Record<string, unknown>,
  path: string[],
  create: false,
): { parent: SectionContainer; key: string; containerSpec: FieldSpec } | null
function locateParent(
  schema: SectionSchema,
  root: Record<string, unknown>,
  path: string[],
  create: boolean,
): { parent: SectionContainer; key: string; containerSpec: FieldSpec } | null {
  const label = `path "${path.join(".")}"`
  let container: SectionContainer = root
  let containerSpec: FieldSpec = { type: "object", fields: schema.fields }
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]
    const childSpec = childSpecFor(containerSpec, seg)
    let next: unknown
    if (Array.isArray(container)) {
      if (!isArrayKey(seg)) throw new SettingsValidationError(`${label}: expected array index, got "${seg}"`)
      const index = Number(seg)
      if (index >= container.length) {
        throw new SettingsValidationError(`${label}: array index ${index} out of bounds (length ${container.length})`)
      }
      next = container[index]
    } else {
      next = container[seg]
    }
    if (next === undefined) {
      if (!create) return null
      const materialized = childSpec.type === "array" ? [] : childSpec.type === "object" ? {} : undefined
      if (materialized === undefined) {
        throw new SettingsValidationError(`${label}: cannot descend into ${childSpec.type} field "${seg}"`)
      }
      if (Array.isArray(container)) {
        container[Number(seg)] = materialized
      } else {
        container[seg] = materialized
      }
      next = materialized
    }
    if (!isRecord(next) && !Array.isArray(next)) {
      throw new SettingsValidationError(`${label}: cannot descend into non-object at "${seg}"`)
    }
    container = next
    containerSpec = childSpec
  }
  return { parent: container, key: path[path.length - 1], containerSpec }
}

function applyOp(schema: SectionSchema, root: Record<string, unknown>, op: SectionOp): void {
  if (op.path.length === 0) throw new SettingsValidationError("op path must not be empty")
  if (op.op === "set") {
    const target = locateParent(schema, root, op.path, true)
    // Unknown terminal keys only error for fixed containers (maps accept any
    // dynamic key, e.g. provider routes); array containers enforce canonical
    // indices in setIn/unsetIn.
    const keySpec = childSpecFor(target.containerSpec, target.key)
    const where = op.path.join(".")
    validateValue(keySpec, op.value, where)
    setIn(target.parent, target.key, op.value, where)
    return
  }
  const target = locateParent(schema, root, op.path, false)
  if (target === null) return // no-op: nothing stored at that path
  childSpecFor(target.containerSpec, target.key)
  unsetIn(target.parent, target.key, op.path.join("."))
}

/** Deterministic JSON serialization (sorted keys) for content comparison. */
function stableStringify(value: unknown): string {
  if (value === undefined) return JSON.stringify(null)
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`
}

/**
 * Apply validated path ops to a section under the revision guard.
 *
 * - expectedRevision mismatch → SettingsConflictError {expected, actual}
 *   (checked before ops validation: a stale client gets 409, not 400);
 * - every op is validated against the section schema (unknown fields, wrong
 *   types, bad enum values → SettingsValidationError);
 * - the section counter advances only when the persisted content actually
 *   changes (no-op ops keep the revision), and every successful apply persists
 *   atomically through the store.
 *
 * @param name         section key ("llm" | "onboarding")
 * @param ops          set/unset path ops, applied in order
 * @param store        the settings store (load before mutating)
 * @param expectedRevision optional revision the caller last described
 * @returns the updated redacted SectionView
 */
export async function mutateSection(
  name: SectionName,
  ops: SectionOp[],
  store: SettingsStoreSurface,
  expectedRevision?: number,
): Promise<SectionView> {
  const schema = SECTION_SCHEMAS[name]
  const current = store.get()[name] as unknown as Record<string, unknown>
  const actual = store.getSectionRevision(name)
  if (expectedRevision !== undefined && expectedRevision !== actual) {
    throw new SettingsConflictError(expectedRevision, actual)
  }
  const next = structuredClone(current)
  for (const op of ops) applyOp(schema, next, op)
  if (stableStringify(next) === stableStringify(current)) {
    return describeSection(name, store) // content unchanged → no persist, no bump
  }
  // Values are schema-validated above; the cast bridges the generic
  // Record<string, unknown> section carrier to the concrete section shape.
  await store.set(
    name === "llm"
      ? { llm: next as unknown as SettingsLlm }
      : { onboarding: next as unknown as SettingsOnboarding },
  )
  return describeSection(name, store)
}
