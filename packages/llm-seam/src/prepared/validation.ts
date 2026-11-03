import type { RouteKind } from '../binding.ts'
import type { PreparedModelRequest } from './types.ts'

export type ValidationRule = 'shape' | 'binding' | 'tool-id' | 'tool-group' | 'native-replay' | 'parameter-type' | 'parameter-conflict' | 'unsupported-parameter' | 'output-range' | 'body-limit' | 'media-limit'
export type ValidationSite = 'request' | 'model' | 'messages' | 'input' | 'tools' | 'native' | 'generation' | 'media'
export type CoverageGap = 'legacy-tool-ownership' | 'native-origin-unknown' | 'native-contract-unavailable' | 'protocol-contract-unavailable' | 'extension-unchecked' | 'limit-unverified' | 'remote-input-unavailable' | 'custom-client'
export type FinalRejectionReason = 'schema' | 'message-order' | 'unsupported-parameter' | 'binding' | 'native-replay' | 'output-limit' | 'media-limit'
export interface PreparedValidation {
  version: 1
  route: RouteKind | 'custom'
  contract: 'responses-v1' | 'subscription-v1' | 'chat-v1' | 'anthropic-v1' | 'gemini-v1' | 'bedrock-v1' | 'neutral-only-v1'
  status: 'checked' | 'partial' | 'invalid'
  coverage: 'final-protocol' | 'neutral-only' | 'unvalidated-protocol'
  native: 'absent' | 'preserved' | 'unverified' | 'incompatible'
  issues: readonly { rule: ValidationRule; site: ValidationSite }[]
  gaps: readonly CoverageGap[]
  omittedIssueCount: number
}
export type FinalValidation = { kind: 'accepted'; report: PreparedValidation } | { kind: 'rejected'; reason: FinalRejectionReason; report: PreparedValidation }
export type FinalValidationPacket = { readonly kind: 'http-json-body'; readonly bodyBytes: number } | { readonly kind: 'sdk-command-estimate'; readonly sdkCommandBytesEstimate: number }
export type FinalValidator<T> = (actualBody: T, packet: FinalValidationPacket) => FinalValidation
const contracts = new Map<string, PreparedValidation['contract']>([
  ['openai-responses', 'responses-v1'], ['openai-responses-subscription', 'subscription-v1'], ['openai-compatible', 'chat-v1'],
  ['anthropic-messages', 'anthropic-v1'], ['gemini', 'gemini-v1'], ['bedrock', 'bedrock-v1'], ['custom', 'neutral-only-v1'],
])
const rules: readonly ValidationRule[] = ['shape', 'binding', 'tool-id', 'tool-group', 'native-replay', 'parameter-type', 'parameter-conflict', 'unsupported-parameter', 'output-range', 'body-limit', 'media-limit']
const sites: readonly ValidationSite[] = ['request', 'model', 'messages', 'input', 'tools', 'native', 'generation', 'media']
const gaps: readonly CoverageGap[] = ['legacy-tool-ownership', 'native-origin-unknown', 'native-contract-unavailable', 'protocol-contract-unavailable', 'extension-unchecked', 'limit-unverified', 'remote-input-unavailable', 'custom-client']
const reasonRules: Record<FinalRejectionReason, readonly ValidationRule[]> = {
  schema: ['shape', 'parameter-type', 'parameter-conflict', 'body-limit', 'media-limit'],
  'media-limit': ['media-limit'],
  'message-order': ['tool-id', 'tool-group'], 'unsupported-parameter': ['unsupported-parameter'],
  binding: ['binding'], 'native-replay': ['native-replay'], 'output-limit': ['output-range'],
}
/** Only own, enumerable data fields; Object.prototype names are never a schema. */
function fields(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === names.length && keys.every(key => typeof key === 'string' && names.includes(key))
    && names.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable === true && Object.hasOwn(d, 'value') })
}
function array(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i))
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) return false
  }
  return true
}
/** A small data-only codec shared with error classification. No payload values
 * or paths can enter this DTO, even through a process/storage boundary. */
export function sanitizePreparedValidation(value: unknown): PreparedValidation | undefined {
  if (!fields(value, ['version', 'route', 'contract', 'status', 'coverage', 'native', 'issues', 'gaps', 'omittedIssueCount'])) return
  if (value.version !== 1 || typeof value.route !== 'string' || !contracts.has(value.route) || contracts.get(value.route) !== value.contract) return
  if (!['checked', 'partial', 'invalid'].includes(value.status as string) || !['final-protocol', 'neutral-only', 'unvalidated-protocol'].includes(value.coverage as string) || !['absent', 'preserved', 'unverified', 'incompatible'].includes(value.native as string)) return
  if (!array(value.issues, 12) || !array(value.gaps, gaps.length) || !Number.isSafeInteger(value.omittedIssueCount) || (value.omittedIssueCount as number) < 0 || (value.omittedIssueCount as number) > 65535) return
  const issueKeys = new Set<string>(), checkedIssues: PreparedValidation['issues'][number][] = []
  for (const issue of value.issues) {
    if (!fields(issue, ['rule', 'site']) || !rules.includes(issue.rule as ValidationRule) || !sites.includes(issue.site as ValidationSite)) return
    const key = `${issue.rule}:${issue.site}`
    if (issueKeys.has(key)) return
    issueKeys.add(key); checkedIssues.push(Object.freeze({ rule: issue.rule as ValidationRule, site: issue.site as ValidationSite }))
  }
  const checkedGaps: CoverageGap[] = []
  for (const gap of value.gaps) {
    if (!gaps.includes(gap as CoverageGap) || checkedGaps.includes(gap as CoverageGap)) return
    checkedGaps.push(gap as CoverageGap)
  }
  if (value.status === 'invalid' ? !checkedIssues.length : checkedIssues.length || value.omittedIssueCount !== 0 || value.native === 'incompatible') return
  if (value.status === 'checked' && (checkedGaps.length || value.coverage !== 'final-protocol' || value.native === 'unverified')) return
  if (value.status === 'partial' && !checkedGaps.length) return
  if (value.coverage === 'neutral-only' && value.route !== 'custom' || value.route === 'custom' && value.coverage !== 'neutral-only') return
  if (value.coverage === 'unvalidated-protocol' && !checkedGaps.includes('protocol-contract-unavailable')) return
  if (value.route === 'custom' && !checkedGaps.includes('custom-client')) return
  return Object.freeze({ version: 1, route: value.route as PreparedValidation['route'], contract: value.contract as PreparedValidation['contract'], status: value.status as PreparedValidation['status'], coverage: value.coverage as PreparedValidation['coverage'], native: value.native as PreparedValidation['native'], issues: Object.freeze(checkedIssues), gaps: Object.freeze(checkedGaps), omittedIssueCount: value.omittedIssueCount as number })
}
export function createPreparedValidation(value: PreparedValidation): PreparedValidation {
  if (!fields(value, ['version', 'route', 'contract', 'status', 'coverage', 'native', 'issues', 'gaps', 'omittedIssueCount'])
    || !array(value.issues, Number.MAX_SAFE_INTEGER) || !array(value.gaps, Number.MAX_SAFE_INTEGER)
    || !value.issues.every(issue => fields(issue, ['rule', 'site']))) throw new TypeError('Invalid prepared validation contract')
  const unique = new Map<string, PreparedValidation['issues'][number]>()
  for (const issue of value.issues) unique.set(`${issue.rule}:${issue.site}`, issue)
  const all = [...unique.values()]
  const report = sanitizePreparedValidation({ ...value, issues: all.slice(0, 12), gaps: [...new Set(value.gaps)], omittedIssueCount: Math.min(65535, Math.max(0, value.omittedIssueCount) + Math.max(0, all.length - 12)) })
  if (!report) throw new TypeError('Invalid prepared validation contract')
  return report
}
export function coherentRejection(reason: unknown, report: PreparedValidation): reason is FinalRejectionReason {
  return report.status === 'invalid' && typeof reason === 'string' && Object.hasOwn(reasonRules, reason)
    && report.issues.some(issue => reasonRules[reason as FinalRejectionReason].includes(issue.rule))
}
export function localValidationRejection(value: unknown): { reason: FinalRejectionReason; report: PreparedValidation } | undefined {
  if (!value || typeof value !== 'object') return
  const own = (key: string) => { const d = Object.getOwnPropertyDescriptor(value, key); return d && Object.hasOwn(d, 'value') ? d.value : undefined }
  if (own('code') !== 'INVALID_ARGUMENT') return
  const report = sanitizePreparedValidation(own('validation')), reason = own('reason')
  if (report && coherentRejection(reason, report)) return { reason, report }
}
/** Bounded accumulating state; schemas/argument trees are never traversed. */
export function validationCollector(route: PreparedValidation['route']) {
  const issues: PreparedValidation['issues'][number][] = [], missing = new Set<CoverageGap>(), seen = new Set<string>()
  let omittedIssueCount = 0, reason: FinalRejectionReason = 'schema', native: PreparedValidation['native'] = route === 'custom' ? 'unverified' : 'absent'
  if (route === 'custom') missing.add('custom-client')
  return {
    issue(rule: ValidationRule, site: ValidationSite, why: FinalRejectionReason = 'schema') {
      const key = `${rule}:${site}`
      if (seen.has(key)) return
      seen.add(key)
      if (!issues.length) reason = why
      if (issues.length < 12) issues.push({ rule, site })
      else omittedIssueCount = Math.min(65535, omittedIssueCount + 1)
    },
    gap(gap: CoverageGap) { missing.add(gap) },
    native(value: PreparedValidation['native'] = 'unverified') {
      if (native === 'incompatible') return
      native = value
      if (value === 'unverified') missing.add('native-origin-unknown')
      else if (value === 'preserved') missing.delete('native-origin-unknown')
    },
    finish(): FinalValidation {
      const report = createPreparedValidation({ version: 1, route, contract: contracts.get(route)!, status: issues.length ? 'invalid' : missing.size ? 'partial' : 'checked', coverage: route === 'custom' ? 'neutral-only' : 'final-protocol', native, issues, gaps: [...missing], omittedIssueCount })
      return issues.length ? { kind: 'rejected', reason, report } : { kind: 'accepted', report }
    },
  }
}
export function readPreparedValidation(prepared: Pick<PreparedModelRequest, 'validation' | 'measurement'>): PreparedValidation {
  if (prepared.validation !== undefined) {
    const report = sanitizePreparedValidation(prepared.validation)
    if (!report) throw new TypeError('Invalid prepared validation contract')
    return report
  }
  const protocol = prepared.measurement.input.protocol
  const route = contracts.has(protocol) ? protocol as PreparedValidation['route'] : 'custom'
  return createPreparedValidation({ version: 1, route, contract: contracts.get(route)!, status: 'partial', coverage: route === 'custom' ? 'neutral-only' : 'unvalidated-protocol', native: 'unverified', issues: [], gaps: route === 'custom' ? ['custom-client'] : ['protocol-contract-unavailable'], omittedIssueCount: 0 })
}
