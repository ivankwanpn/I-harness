// Workflow definition model + YAML parsing (spec §3.2). The YAML subset is
// parsed with the generic `yaml` package — complete YAML 1.2, NOT hand-rolled
// (silent edge-case mis-parses would mean wrong commands; user ruling: generic
// suites allowed, private libs banned). Validation is fail-loud: a definition
// that violates the schema throws a descriptive WorkflowParseError, which the
// registry translates into warn+skip (one bad file never breaks the registry).
//
// Deliberately NOT implemented (YAGNI, ruling M24b-P4): DAG/parallel steps,
// conditions, loops, matrices — steps run strictly sequentially, in order.
import { parse as parseYaml } from "yaml"

export interface WorkflowStep {
  name: string
  command: string
  cwd?: string
  env?: Record<string, string>
  timeout_ms?: number
  retry?: { attempts: number; backoff_ms?: number }
  on_failure?: "stop" | "continue"
}

export interface WorkflowParamSpec {
  description?: string
  default?: string
  required?: boolean
}

export interface WorkflowDefinition {
  name: string
  description: string
  whenToUse?: string
  params?: Record<string, WorkflowParamSpec>
  steps: WorkflowStep[]
}

// Same dsh kebab grammar the skills package uses (one vocabulary across M24b).
export const WORKFLOW_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isValidWorkflowName(name: string): boolean {
  return WORKFLOW_NAME_PATTERN.test(name)
}

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowParseError"
  }
}

type PlainObject = Record<string, unknown>

function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function requireString(obj: PlainObject, field: string, what: string): string {
  const v = obj[field]
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new WorkflowParseError(`${what}: '${field}' is required and must be a non-empty string`)
  }
  return v
}

function optionalString(obj: PlainObject, field: string, what: string): string | undefined {
  const v = obj[field]
  if (v === undefined) return undefined
  if (typeof v !== "string") throw new WorkflowParseError(`${what}: '${field}' must be a string`)
  return v
}

function parseParams(raw: unknown, what: string): Record<string, WorkflowParamSpec> {
  if (raw === undefined) return {}
  if (!isPlainObject(raw)) throw new WorkflowParseError(`${what}: 'params' must be a mapping of param name → spec`)
  const params: Record<string, WorkflowParamSpec> = {}
  for (const [key, value] of Object.entries(raw)) {
    // Scalar shorthand (`param: dev`) is NOT accepted — the spec type is the
    // spec-object form; fail loud so the author fixes the file.
    if (!isPlainObject(value)) {
      throw new WorkflowParseError(`${what}: param '${key}' must be a mapping ({ description?, default?, required? })`)
    }
    const spec: WorkflowParamSpec = {}
    const description = value["description"]
    if (description !== undefined) {
      if (typeof description !== "string") throw new WorkflowParseError(`${what}: param '${key}' description must be a string`)
      spec.description = description
    }
    const dflt = value["default"]
    if (dflt !== undefined) {
      if (typeof dflt !== "string") throw new WorkflowParseError(`${what}: param '${key}' default must be a string`)
      spec.default = dflt
    }
    const required = value["required"]
    if (required !== undefined) {
      if (typeof required !== "boolean") throw new WorkflowParseError(`${what}: param '${key}' required must be a boolean`)
      spec.required = required
    }
    params[key] = spec
  }
  return params
}

function parseStep(raw: unknown, index: number, what: string): WorkflowStep {
  const label = `${what}: steps[${index}]`
  if (!isPlainObject(raw)) throw new WorkflowParseError(`${label} must be a mapping`)
  const name = requireString(raw, "name", label)
  const command = requireString(raw, "command", label)
  const step: WorkflowStep = { name, command }
  const cwd = optionalString(raw, "cwd", label)
  if (cwd !== undefined) step.cwd = cwd
  const envRaw = raw["env"]
  if (envRaw !== undefined) {
    if (!isPlainObject(envRaw)) throw new WorkflowParseError(`${label}: 'env' must be a string → string mapping`)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(envRaw)) {
      if (typeof v !== "string") throw new WorkflowParseError(`${label}: env '${k}' must be a string`)
      env[k] = v
    }
    step.env = env
  }
  const timeout = raw["timeout_ms"]
  if (timeout !== undefined) {
    if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
      throw new WorkflowParseError(`${label}: 'timeout_ms' must be a positive number`)
    }
    step.timeout_ms = timeout
  }
  const retryRaw = raw["retry"]
  if (retryRaw !== undefined) {
    if (!isPlainObject(retryRaw)) throw new WorkflowParseError(`${label}: 'retry' must be a mapping ({ attempts, backoff_ms? })`)
    const attempts = retryRaw["attempts"]
    if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 1) {
      // attempts counts TOTAL executions (1 = run once, no retry).
      throw new WorkflowParseError(`${label}: retry.attempts must be a positive integer (total attempts, 1 = no retry)`)
    }
    const retry: { attempts: number; backoff_ms?: number } = { attempts }
    const backoff = retryRaw["backoff_ms"]
    if (backoff !== undefined) {
      if (typeof backoff !== "number" || !Number.isFinite(backoff) || backoff < 0) {
        throw new WorkflowParseError(`${label}: retry.backoff_ms must be a non-negative number`)
      }
      retry.backoff_ms = backoff
    }
    step.retry = retry
  }
  const onFailure = raw["on_failure"]
  if (onFailure !== undefined) {
    if (onFailure !== "stop" && onFailure !== "continue") {
      throw new WorkflowParseError(`${label}: 'on_failure' must be "stop" or "continue"`)
    }
    step.on_failure = onFailure
  }
  return step
}

// Parse one workflow YAML document into a validated WorkflowDefinition.
// Throws WorkflowParseError (fail-loud) on any schema violation:
//   - root must be a YAML mapping
//   - name: kebab (dsh grammar); when absent, `fallbackName` (the file stem)
//     is used — callers without a fallback pass undefined and a missing name
//     fails loud
//   - description: required non-empty (fail-loud per spec)
//   - steps: required non-empty array; per-step name/command required
// Unknown top-level keys are tolerated (forward-compatible vocabulary — the
// dsh meta set includes `phases`, deferred in v0, and must not reject files
// that carry it).
export function parseWorkflowYaml(text: string, opts?: { fallbackName?: string }): WorkflowDefinition {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (e) {
    throw new WorkflowParseError(`invalid YAML: ${e instanceof Error ? e.message : String(e)}`)
  }
  const what = "workflow"
  if (!isPlainObject(doc)) {
    throw new WorkflowParseError(`${what}: top-level document must be a mapping (name/description/steps)`)
  }
  let name = optionalString(doc, "name", what)
  if (name === undefined) {
    if (opts?.fallbackName === undefined) {
      throw new WorkflowParseError(`${what}: 'name' is required when no file-stem fallback is available`)
    }
    name = opts.fallbackName
  }
  if (!isValidWorkflowName(name)) {
    throw new WorkflowParseError(`${what}: name '${name}' must be kebab-case (/^[a-z0-9]+(?:-[a-z0-9]+)*$/)`)
  }
  const description = requireString(doc, "description", what)
  const whenToUse = optionalString(doc, "whenToUse", what)
  const params = parseParams(doc["params"], what)
  const stepsRaw = doc["steps"]
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new WorkflowParseError(`${what}: 'steps' is required and must be a non-empty array`)
  }
  const definition: WorkflowDefinition = {
    name,
    description,
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
    steps: stepsRaw.map((s, i) => parseStep(s, i, what)),
  }
  return definition
}
