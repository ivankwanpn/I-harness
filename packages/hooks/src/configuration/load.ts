import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { resolveHarnessHome } from "@i-harness/harness-home"
import type { ClaudePluginHooksOptions } from "../types.ts"
import { HookConfigError, HookUnsupportedFormatError } from "../types.ts"
import type { LoadedHandler } from "../registry-types.ts"
import { verifyHandlerTrust } from "../trust.ts"
import { adaptClaudePluginHooks } from "../claude.ts"
import { compileMatcher } from "./matchers.ts"
import { validateSpec } from "./validation.ts"

const CONFIG_FILE = "hooks.json"

/** @i-harness/settings config-home convention (no cross-package import). */
export function resolveHooksConfigPath(configDir?: string): string {
  // The explicit case keeps `resolve` (it normalises a relative dir); only the
  // default chain moves out, to the one package that resolves the harness home.
  if (configDir !== undefined) return resolve(configDir, CONFIG_FILE)
  return join(resolveHarnessHome(), CONFIG_FILE)
}

/**
 * Strict config load: version 1, every handler's fields validated.
 *
 * TWO TRUST QUESTIONS, and a handler must pass both — they catch different lies:
 *
 *   1. **Was the declaration ever GRANTED?** A config's `trust.sha256` is
 *      written by whoever wrote the config, so on its own it means nothing:
 *      a config naming its own script and its own hash satisfies it entirely.
 *      The rule (D1, docs/handoff/2026-09-18-prior-art-survey.md): **a declaring
 *      layer may declare; only the user layer may grant.** The user layer is
 *      THIS config being the one the harness-home convention resolves to —
 *      derived from the path, never from a caller's claim, so another tree's
 *      `hooks/hooks.json` cannot assert its way in.
 *   2. **Do the bytes still match?** `verifyHandlerTrust` recomputes the
 *      artifact's hash. That is what catches a granted script edited later.
 *
 * `approvals` is the user-layer store. Omitted, a non-home config grants nothing
 * — fail-closed by omission rather than by a flag someone can get wrong.
 */
export async function loadHooksConfig(
  configPath: string,
  configDir: string,
  approvals?: { isApproved(sha256: string): boolean },
  options: ClaudePluginHooksOptions = {},
): Promise<LoadedHandler[]> {
  let text: string
  try {
    text = await readFile(configPath, "utf8")
  } catch (err) {
    throw new HookConfigError(`hooks config ${configPath} unreadable: ${err instanceof Error ? err.message : String(err)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new HookConfigError(`hooks config ${configPath} is not valid JSON`)
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HookConfigError("hooks config must be a JSON object")
  }
  const cfg = raw as Record<string, unknown>
  // Native fields take precedence: an invalid or mixed native policy must not
  // acquire the optional-plugin containment reserved for this foreign format.
  if (!Object.hasOwn(cfg, "version") && !Object.hasOwn(cfg, "handlers")
    && typeof cfg.hooks === "object" && cfg.hooks !== null && !Array.isArray(cfg.hooks)
    && Object.values(cfg.hooks).every(Array.isArray)) {
    if (options.claudePluginRoot !== undefined) return adaptClaudePluginHooks(cfg, configPath, text, approvals, { ...options, claudePluginRoot: options.claudePluginRoot })
    throw new HookUnsupportedFormatError()
  }
  if (cfg.version !== 1) throw new HookConfigError("hooks config version must be 1")
  if (!Array.isArray(cfg.handlers)) throw new HookConfigError("hooks config must carry a handlers array")
  const userLayer = resolve(configPath) === resolve(resolveHooksConfigPath())
  const loaded: LoadedHandler[] = []
  for (const entry of cfg.handlers) {
    const spec = validateSpec(entry, configPath)
    compileMatcher(spec.matcher) // regex validity is a config error
    let trustError: string | undefined
    let unapproved = false
    try {
      await verifyHandlerTrust(spec, configDir)
    } catch (err) {
      trustError = err instanceof Error ? err.message : String(err)
    }
    if (trustError === undefined && !userLayer && approvals?.isApproved(spec.trust.sha256) !== true) {
      trustError = `hook handler ${spec.id} is not approved by the user for this source (sha256 ${spec.trust.sha256})`
      unapproved = true
    }
    loaded.push({ spec, valid: trustError === undefined, trustError, ...(unapproved ? { unapproved } : {}) })
  }
  return loaded
}
