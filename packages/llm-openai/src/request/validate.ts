import { validationCollector, type FinalValidator } from '@i-harness/llm-seam'
import type { OpenAIConfig } from '../types.ts'

type Checks = ReturnType<typeof validationCollector>
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
function extensions(value: Record<string, unknown>, names: readonly string[], check: Checks): void {
  if (Object.keys(value).some(key => !names.includes(key))) check.gap('extension-unchecked')
}
function jsonArguments(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try { JSON.parse(value); return true } catch { return false }
}
const inputParts = ['input_text', 'input_image', 'input_file']
const knownParts = [...inputParts, 'output_text', 'summary_text', 'reasoning_text', 'refusal']
function content(value: unknown, check: Checks, allowed = inputParts, native = false): void {
  const malformed = () => native ? check.issue('native-replay', 'native', 'native-replay') : check.issue('shape', 'input')
  if (typeof value === 'string' && !native) return
  if (!Array.isArray(value)) { malformed(); return }
  for (const part of value) {
    if (!record(part) || !text(part.type)) { malformed(); continue }
    if (knownParts.includes(part.type) && !allowed.includes(part.type)) {
      if (native) check.issue('native-replay', 'native', 'native-replay')
      else check.issue('shape', 'input')
      continue
    }
    extensions(part, ['type', 'text', 'annotations', 'logprobs', 'refusal', 'image_url', 'file_id', 'detail', 'file_url', 'file_data', 'filename', 'prompt_cache_breakpoint'], check)
    switch (part.type) {
      case 'input_text': case 'output_text': case 'summary_text': case 'reasoning_text':
        if (typeof part.text !== 'string') malformed()
        break
      case 'refusal':
        if (typeof part.refusal !== 'string') check.issue('shape', 'input')
        break
      case 'input_image':
        if (!text(part.image_url) && !text(part.file_id)) check.issue('shape', 'media')
        for (const key of ['image_url', 'file_id']) if (part[key] != null && typeof part[key] !== 'string') check.issue('parameter-type', 'media')
        if (part.detail !== undefined && !['auto', 'low', 'high', 'original'].includes(part.detail as string)) check.issue('parameter-type', 'media')
        if (part.file_id != null || typeof part.image_url !== 'string' || !part.image_url.startsWith('data:')) check.gap('remote-input-unavailable')
        break
      case 'input_file':
        if (![part.file_id, part.file_url, part.file_data].some(text)) check.issue('shape', 'media')
        for (const key of ['file_id', 'file_url', 'file_data', 'filename']) if (part[key] != null && typeof part[key] !== 'string') check.issue('parameter-type', 'media')
        check.gap('remote-input-unavailable')
        break
      default: check.gap('extension-unchecked')
    }
  }
}
/** Tool parameter schemas stay opaque. Only the wire envelope is inspected. */
function tools(value: unknown, check: Checks, subscription: boolean): void {
  if (value === undefined && !subscription) return
  if (!Array.isArray(value)) { check.issue('shape', 'tools'); return }
  const work: { value: unknown; nested: boolean }[] = value.map(value => ({ value, nested: false }))
  while (work.length) {
    const { value: tool, nested } = work.pop()!
    if (!record(tool) || !text(tool.type)) { check.issue('shape', 'tools'); continue }
    if (tool.type === 'function') {
      extensions(tool, ['type', 'name', 'description', 'parameters', 'strict', 'defer_loading'], check)
      if (!text(tool.name) || tool.description != null && typeof tool.description !== 'string' || tool.parameters != null && !record(tool.parameters) || tool.strict != null && typeof tool.strict !== 'boolean') check.issue('shape', 'tools')
      if (subscription && !nested) check.issue('unsupported-parameter', 'tools', 'unsupported-parameter')
    } else if (tool.type === 'namespace') {
      extensions(tool, ['type', 'name', 'description', 'tools'], check)
      if (nested || !text(tool.name) || !Array.isArray(tool.tools)) { check.issue('shape', 'tools'); continue }
      if (subscription && tool.name !== 'ih') check.issue('unsupported-parameter', 'tools', 'unsupported-parameter')
      for (const value of tool.tools) work.push({ value, nested: true })
    } else if (subscription) check.issue('unsupported-parameter', 'tools', 'unsupported-parameter')
    else check.gap('extension-unchecked')
  }
}
const subscriptionFields = new Set(['model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'store', 'stream', 'stream_options', 'include', 'service_tier', 'prompt_cache_key', 'text', 'client_metadata', 'access_programs'])
function subscriptionBody(body: Record<string, unknown>, check: Checks): void {
  if (Object.keys(body).some(key => !subscriptionFields.has(key))) check.issue('unsupported-parameter', 'request', 'unsupported-parameter')
  if (body.store !== false || body.stream !== true) check.issue('unsupported-parameter', 'request', 'unsupported-parameter')
  if (!Array.isArray(body.include) || !body.include.every(value => typeof value === 'string') || !body.include.includes('reasoning.encrypted_content')) check.issue('unsupported-parameter', 'native', 'unsupported-parameter')
}

// Explicit native alternatives are retained in place. Their authenticity and
// backend lifecycle remain unverified; none opens an IH function obligation.
const hosted = new Set(['web_search_call', 'file_search_call', 'computer_call', 'computer_call_output', 'code_interpreter_call', 'image_generation_call', 'local_shell_call', 'local_shell_call_output', 'shell_call', 'shell_call_output', 'apply_patch_call', 'apply_patch_call_output', 'mcp_call', 'mcp_list_tools', 'mcp_approval_request', 'mcp_approval_response', 'compaction'])
const publicFields = new Set([...subscriptionFields, 'max_output_tokens', 'previous_response_id', 'conversation', 'prompt', 'temperature', 'top_p', 'truncation', 'metadata', 'user', 'safety_identifier', 'prompt_cache_retention', 'prompt_cache_options', 'background', 'max_tool_calls', 'top_logprobs'])
function parameters(body: Record<string, unknown>, check: Checks): void {
  for (const key of ['reasoning', 'text', 'stream_options', 'prompt'] as const) {
    if (body[key] != null && !record(body[key])) check.issue('parameter-type', 'request')
  }
  if (record(body.reasoning)) {
    extensions(body.reasoning, ['effort', 'summary', 'generate_summary'], check)
    for (const key of ['effort', 'summary', 'generate_summary']) if (body.reasoning[key] != null && typeof body.reasoning[key] !== 'string') check.issue('parameter-type', 'generation')
  }
  if (record(body.text)) {
    extensions(body.text, ['format', 'verbosity'], check)
    if (body.text.format !== undefined && (!record(body.text.format) || !text(body.text.format.type))) check.issue('parameter-type', 'generation')
    if (body.text.verbosity !== undefined && typeof body.text.verbosity !== 'string') check.issue('parameter-type', 'generation')
  }
  if (record(body.prompt) && !text(body.prompt.id)) check.issue('shape', 'request')
  if (body.include != null && (!Array.isArray(body.include) || !body.include.every(value => typeof value === 'string'))) check.issue('parameter-type', 'request')
  if (body.tool_choice !== undefined && typeof body.tool_choice !== 'string' && !record(body.tool_choice)) check.issue('parameter-type', 'tools')
  if (record(body.tool_choice) && !text(body.tool_choice.type)) check.issue('shape', 'tools')
}
function itemShape(item: Record<string, unknown>, check: Checks): void {
  if (item.type === 'message' || item.type === undefined && item.role !== undefined) {
    extensions(item, ['type', 'id', 'role', 'content', 'status', 'phase'], check)
    if (!['system', 'developer', 'user', 'assistant'].includes(item.role as string)) check.issue('shape', 'input')
    content(item.content, check, item.role === 'assistant' ? [...inputParts, 'output_text', 'refusal'] : inputParts)
    if (item.phase !== undefined && item.phase !== null && typeof item.phase !== 'string') check.issue('shape', 'input')
  } else if (item.type === 'reasoning') {
    extensions(item, ['type', 'id', 'summary', 'content', 'encrypted_content', 'status'], check)
    check.native()
    if (!Array.isArray(item.summary)) check.issue('native-replay', 'native', 'native-replay')
    else content(item.summary, check, ['summary_text'], true)
    if (item.content !== undefined) content(item.content, check, ['reasoning_text'], true)
    if (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== 'string') check.issue('native-replay', 'native', 'native-replay')
  } else if (item.type === 'item_reference') {
    extensions(item, ['type', 'id'], check)
    if (!text(item.id)) check.issue('shape', 'input')
    check.gap('remote-input-unavailable')
  } else if (hosted.has(item.type as string)) {
    check.native(); check.gap('native-contract-unavailable')
    if (item.id != null && !text(item.id) || item.status != null && typeof item.status !== 'string') check.issue('native-replay', 'native', 'native-replay')
  } else if (!text(item.type)) check.issue('shape', 'input')
  else { check.native(); check.gap('extension-unchecked'); check.gap('native-contract-unavailable') }
}
function inputGroups(input: unknown[], body: Record<string, unknown>, check: Checks, subscription: boolean): void {
  const visible = new Set<string>(), pending = new Map<string, boolean>(), completed = new Set<string>()
  for (const item of input) {
    if (!record(item) || item.type !== 'function_call') continue
    if (!text(item.call_id) || visible.has(item.call_id)) check.issue('tool-id', 'input', 'message-order')
    else visible.add(item.call_id)
  }
  let remote = !subscription && (text(body.previous_response_id) || text(body.conversation) || record(body.conversation) && text(body.conversation.id))
  for (const item of input) {
    if (!record(item)) { check.issue('shape', 'input'); continue }
    if (item.type === 'function_call') {
      extensions(item, ['type', 'id', 'call_id', 'name', 'namespace', 'arguments', 'status', 'async'], check)
      if (!text(item.name) || !jsonArguments(item.arguments)) check.issue('shape', 'input')
      if (item.async !== undefined && typeof item.async !== 'boolean') check.issue('parameter-type', 'native')
      if (subscription && item.namespace !== 'ih') check.issue('unsupported-parameter', 'tools', 'unsupported-parameter')
      if (item.namespace !== undefined && !text(item.namespace)) check.issue('shape', 'tools')
      if (text(item.call_id)) pending.set(item.call_id, item.async === true)
      if (item.async === true) { check.native(); check.gap('native-contract-unavailable') }
    } else if (item.type === 'function_call_output') {
      extensions(item, ['type', 'id', 'call_id', 'output', 'status'], check)
      if (!text(item.call_id)) { check.issue('tool-id', 'input', 'message-order'); continue }
      if (completed.has(item.call_id)) check.issue('tool-group', 'input', 'message-order')
      else if (pending.has(item.call_id)) pending.delete(item.call_id)
      else if (visible.has(item.call_id) || !remote) check.issue('tool-group', 'input', 'message-order')
      else check.gap('remote-input-unavailable')
      completed.add(item.call_id)
      content(item.output, check)
    } else {
      itemShape(item, check)
      if (!subscription && item.type === 'item_reference' && text(item.id)) remote = true
    }
  }
  for (const async of pending.values()) {
    if (async) check.issue('unsupported-parameter', 'native', 'unsupported-parameter')
    else check.issue('tool-group', 'input', 'message-order')
  }
}
/** Literal final-body grammar, independent of the neutral encoder. */
export function responsesValidator(config: Pick<OpenAIConfig, 'model' | 'baseUrl'>, subscription: boolean): FinalValidator<unknown> {
  return body => {
    const check = validationCollector(subscription ? 'openai-responses-subscription' : 'openai-responses')
    if (!record(body)) { check.issue('shape', 'request'); return check.finish() }
    if (!text(body.model)) check.issue('shape', 'model')
    else if (body.model !== config.model) check.issue('binding', 'model', 'binding')
    parameters(body, check)
    if (subscription) subscriptionBody(body, check)
    else {
      if (Object.keys(body).some(key => !publicFields.has(key))) check.gap('extension-unchecked')
      const official = config.baseUrl === undefined || /^https:\/\/api\.openai\.com\/?$/.test(config.baseUrl)
      if (!official) check.gap('limit-unverified')
      if (body.max_output_tokens !== undefined && (!Number.isSafeInteger(body.max_output_tokens) || (body.max_output_tokens as number) < (official ? 16 : 1))) check.issue('output-range', 'generation', 'output-limit')
    }
    for (const key of ['instructions', 'previous_response_id'] as const) if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') check.issue('parameter-type', 'request')
    for (const key of ['stream', 'store', 'parallel_tool_calls', 'background'] as const) if (body[key] != null && typeof body[key] !== 'boolean') check.issue('parameter-type', 'request')
    for (const key of ['temperature', 'top_p'] as const) if (body[key] != null && (typeof body[key] !== 'number' || !Number.isFinite(body[key]))) check.issue('parameter-type', 'generation')
    if (body.previous_response_id != null && body.conversation != null) check.issue('parameter-conflict', 'request')
    if (body.conversation !== undefined && body.conversation !== null && !text(body.conversation) && !(record(body.conversation) && text(body.conversation.id))) check.issue('shape', 'request')
    if (body.previous_response_id != null || body.conversation != null || body.prompt != null) check.gap('remote-input-unavailable')
    tools(body.tools, check, subscription)
    if (Array.isArray(body.input)) inputGroups(body.input, body, check, subscription)
    else if (typeof body.input !== 'string') check.issue('shape', 'input')
    return check.finish()
  }
}
