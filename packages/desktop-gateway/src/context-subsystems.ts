import { isAbsolute } from 'node:path'
import { CONTEXT_OUTPUT_DEFAULTS, CODE_RETRIEVAL_DEFAULTS, type SettingsContextSubsystems, type SettingsContextReference, type SettingsContextOverride } from '@i-harness/settings'
import type { ContextOutputService, ContextOutputStatus, ContextOutputConfig } from '@i-harness/context-output'
import type { CodeRetrievalService, CodeRetrievalStatus, CodeRetrievalConfig } from '@i-harness/code-retrieval'
import { withDesktopSettings } from './settings-file.ts'

export interface ContextSubsystemConfigure extends SettingsContextOverride { scope: 'global' | 'workspace'; resetOverride?: boolean }
export interface ContextSubsystemAction { target: 'context' | 'code'; action: 'clear' | 'update' | 'rebuild' | 'cancel'; sessionId?: string }
export interface ContextSubsystemState {
  workspaceId: string; workspaceKey: string; source: 'global' | 'workspace';
  saved: { contextOutput: ContextOutputConfig; codeRetrieval: CodeRetrievalConfig; references: SettingsContextReference[] };
  global?: ContextSubsystemState['saved'];
  context: ContextOutputStatus; code: CodeRetrievalStatus; applicationError?: string
}
export type ContextSubsystemRequest =
  | { kind: 'desktop/context-subsystems/state'; workspaceId: string }
  | { kind: 'desktop/context-subsystems/configure'; workspaceId: string; patch: ContextSubsystemConfigure }
  | { kind: 'desktop/context-subsystems/action'; workspaceId: string; command: ContextSubsystemAction }

function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid context subsystem object')
  return raw as Record<string, unknown>
}
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Unsupported context subsystem field')
}
function identity(v: unknown, max = 4096): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0')) throw new Error('Invalid context subsystem identity')
}
function validateConfig(raw: unknown, defaults: typeof CONTEXT_OUTPUT_DEFAULTS | typeof CODE_RETRIEVAL_DEFAULTS) {
  const v = object(raw); keys(v, [...Object.keys(defaults), ...('mode' in defaults ? ['embedding'] : [])])
  for (const [key, value] of Object.entries(v)) {
    if (key === 'enabled' || key === 'autoRefresh') { if (typeof value !== 'boolean') throw new Error(`Invalid ${key}`) }
    else if (key === 'mode') { if (value !== 'lexical' && value !== 'hybrid') throw new Error('Invalid retrieval mode') }
    else if (key === 'ignorePatterns') {
      if (!Array.isArray(value) || value.length > 16 || value.some(p => typeof p !== 'string' || !p || p.length > 512 || p.includes('\0'))) throw new Error('Invalid ignore patterns (maximum 16 patterns, 512 characters each)')
    } else if (key === 'embedding') {
      const e = object(value); keys(e, ['provider', 'endpoint', 'model', 'credentialRef', 'dimensions'])
      if (e.provider !== 'ollama' && e.provider !== 'openai-compatible') throw new Error('Invalid embedding provider')
      identity(e.endpoint); identity(e.model)
      const url = new URL(e.endpoint)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Embedding endpoint must not contain credentials or query parameters')
      if (e.credentialRef !== undefined) identity(e.credentialRef)
      if (e.dimensions !== undefined && (!Number.isSafeInteger(e.dimensions) || Number(e.dimensions) < 1 || Number(e.dimensions) > 8192)) throw new Error('Invalid embedding dimensions')
    } else if (!Number.isSafeInteger(value) || Number(value) < (key === 'retentionDays' ? 0 : key === 'maxSearchBytes' && 'mode' in defaults ? 128 : 1) || Number(value) > (key === 'retentionDays' ? 36500 : 2147483647)) throw new Error(`Invalid ${key}`)
  }
}
function validateReferences(raw: unknown): asserts raw is SettingsContextReference[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error('Invalid reference list')
  const ids = new Set<string>()
  for (const item of raw) {
    const row = object(item); keys(row, ['id', 'path', 'label']); identity(row.id, 256); identity(row.label, 256); identity(row.path)
    if (row.id === 'workspace') throw new Error('Reference identity workspace is reserved by the host')
    if (!isAbsolute(row.path) || ids.has(row.id) || ['__proto__', 'constructor', 'prototype'].includes(row.id)) throw new Error('Reference requires a unique identity and explicit absolute path')
    ids.add(row.id)
  }
}
function effective(settings: SettingsContextSubsystems, key: string): ContextSubsystemState['saved'] {
  const override = settings.workspaceOverrides[key]
  return { contextOutput: { ...settings.contextOutput, ...override?.contextOutput }, codeRetrieval: { ...settings.codeRetrieval, ...override?.codeRetrieval }, references: override?.references ?? settings.references }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Services and actor identity belong to the host. This controller creates no service or authority. */
export function createContextSubsystemSettings(options: {
  settingsPath: string; workspaceKey: string; workspaceId: string; contextOutput: ContextOutputService; codeRetrieval: CodeRetrievalService;
  onReferencesChanged?: (references: SettingsContextReference[]) => void | Promise<void>; actionSessionId?: string
}) {
  identity(options.workspaceKey); identity(options.workspaceId)
  let applicationError: string | undefined
  let appliedReferences: SettingsContextReference[] | undefined
  let queue = Promise.resolve()
  const serial = <T>(run: () => Promise<T>): Promise<T> => { const next = queue.then(run); queue = next.then(() => {}, () => {}); return next }
  async function snapshot(): Promise<ContextSubsystemState> {
    return withDesktopSettings(options.settingsPath, async store => {
      const settings = store.get().contextSubsystems
      return { workspaceId: options.workspaceId, workspaceKey: options.workspaceKey, source: settings.workspaceOverrides[options.workspaceKey] ? 'workspace' : 'global', saved: effective(settings, options.workspaceKey), global: { contextOutput: settings.contextOutput, codeRetrieval: settings.codeRetrieval, references: settings.references }, context: options.contextOutput.status(), code: options.codeRetrieval.status(), ...(applicationError ? { applicationError } : {}) }
    })
  }
  async function apply(saved: ContextSubsystemState['saved']) {
    try {
      if (!equal(appliedReferences, saved.references)) { await options.onReferencesChanged?.(structuredClone(saved.references)); appliedReferences = structuredClone(saved.references) }
      const outcomes = await Promise.allSettled([
        equal(options.contextOutput.status().config, saved.contextOutput) ? Promise.resolve() : options.contextOutput.configure(saved.contextOutput),
        equal(options.codeRetrieval.status().config, saved.codeRetrieval) ? Promise.resolve() : options.codeRetrieval.configure(saved.codeRetrieval),
      ])
      const failure = outcomes.find((r): r is PromiseRejectedResult => r.status === 'rejected'); if (failure) throw failure.reason
      applicationError = undefined
    } catch (error) { applicationError = error instanceof Error ? error.message : String(error); throw error }
  }
  return {
    state: () => serial(snapshot),
    sync: () => serial(async () => { const state = await snapshot(); await apply(state.saved); return snapshot() }),
    configure: (raw: unknown) => serial(async () => {
      const command = object(raw); keys(command, ['scope', 'contextOutput', 'codeRetrieval', 'references', 'resetOverride'])
      if (command.scope !== 'global' && command.scope !== 'workspace') throw new Error('Invalid context settings scope')
      if (command.resetOverride !== undefined && (typeof command.resetOverride !== 'boolean' || command.scope !== 'workspace')) throw new Error('Invalid override reset')
      if (command.resetOverride && ['contextOutput', 'codeRetrieval', 'references'].some(k => command[k] !== undefined)) throw new Error('Reset cannot include a patch')
      if (command.contextOutput !== undefined) validateConfig(command.contextOutput, CONTEXT_OUTPUT_DEFAULTS)
      if (command.codeRetrieval !== undefined) validateConfig(command.codeRetrieval, CODE_RETRIEVAL_DEFAULTS)
      if (command.references !== undefined) validateReferences(command.references)
      const next = await withDesktopSettings(options.settingsPath, async store => {
        const settings = structuredClone(store.get().contextSubsystems)
        const target: SettingsContextOverride = command.scope === 'global' ? settings : settings.workspaceOverrides[options.workspaceKey] ?? {}
        if (command.resetOverride) delete settings.workspaceOverrides[options.workspaceKey]
        else {
          if (command.contextOutput !== undefined) target.contextOutput = { ...target.contextOutput, ...command.contextOutput as Partial<ContextOutputConfig> }
          if (command.codeRetrieval !== undefined) target.codeRetrieval = { ...target.codeRetrieval, ...command.codeRetrieval as Partial<CodeRetrievalConfig> }
          if (command.references !== undefined) target.references = structuredClone(command.references as SettingsContextReference[])
          if (command.scope === 'workspace') settings.workspaceOverrides[options.workspaceKey] = target
        }
        const configs = [effective(settings, options.workspaceKey), effective(settings, '')]
        for (const row of configs) if (row.codeRetrieval.mode === 'hybrid' && !row.codeRetrieval.embedding) throw new Error('Hybrid mode requires explicit embedding configuration')
        await store.set({ contextSubsystems: settings }); return effective(store.get().contextSubsystems, options.workspaceKey)
      })
      await apply(next); return snapshot()
    }),
    action: (raw: unknown) => serial(async () => {
      const command = object(raw); keys(command, ['target', 'action', 'sessionId'])
      if (command.target !== 'context' && command.target !== 'code') throw new Error('Invalid context action target')
      if (!['clear', 'update', 'rebuild', 'cancel'].includes(String(command.action))) throw new Error('Invalid context action')
      if (command.sessionId !== undefined) identity(command.sessionId, 1024)
      if (command.target === 'context') {
        if (command.action !== 'clear') throw new Error('Context Mode supports clear only')
        await options.contextOutput.clear(command.sessionId as string | undefined)
      } else {
        if (command.sessionId !== undefined) throw new Error('Code indexing identity belongs to the host')
        if (command.action === 'clear') await options.codeRetrieval.clear()
        else if (command.action === 'cancel') await options.codeRetrieval.cancel()
        else { identity(options.actionSessionId, 1024); await options.codeRetrieval.startIndex({ sessionId: options.actionSessionId }, { force: command.action === 'rebuild' }) }
      }
      return snapshot()
    }),
  }
}
