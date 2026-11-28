import type { LLMStreamEvent } from '@i-harness/llm-seam'

type Item = { id?: string; index?: number; parts: Map<number, Part>; next: number; layout?: (string | null)[] }
type Part = { item: Item; index: number; first?: number; possibleStart?: number; last?: number; final?: string; waiting?: string[]; waitingFinal?: string }
type Chunk = { start: number; text: string; part?: Part }
const indexOf = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Responses deltas are append operations. A final snapshot can supply the
 * missing suffix but cannot replace or insert into already published text. */
export function createResponseText() {
  const byId = new Map<string, Item>(), byIndex = new Map<number, Item>(), items = new Set<Item>()
  const chunks: Chunk[] = []
  let length = 0, checkedThrough = 0, unresolvedThrough = 0
  let bareStart: number | undefined, lastPart: Part | undefined, anonymous: Item | undefined, error: string | undefined
  function invalid(detail: string) { error ??= 'OpenAI response text ' + detail }

  function bind(index: unknown, id: unknown, snapshot = false): Item | undefined {
    if (index !== undefined && !indexOf(index) || id !== undefined && (typeof id !== 'string' || !id)) {
      invalid('has an invalid item address'); return
    }
    const keyed = index === undefined ? undefined : byIndex.get(index), named = id === undefined ? undefined : byId.get(id)
    if (keyed && named && keyed !== named || keyed?.id !== undefined && id !== undefined && keyed.id !== id ||
        named?.index !== undefined && index !== undefined && named.index !== index) { invalid('has conflicting item identities'); return }
    const unaddressed = index === undefined && id === undefined
    if (unaddressed && items.size > 1) { invalid('snapshot has an ambiguous message address'); return }
    const only = unaddressed && items.size === 1 ? items.values().next().value : undefined
    const initial = snapshot && index === 0 && items.size === 1 && anonymous?.index === undefined && anonymous?.id === undefined ? anonymous : undefined
    const known = keyed ?? named ?? (unaddressed ? anonymous ?? only : initial)
    const item: Item = known ?? {parts: new Map(), next:0}
    if (!known) items.add(item)
    if (index !== undefined && !keyed) { item.index = index; byIndex.set(index, item) }
    if (id !== undefined && !named) { item.id = id; byId.set(id, item) }
    if (unaddressed && item.index === undefined && item.id === undefined) anonymous = item
    return item
  }
  function partAt(item: Item, index: unknown): Part | undefined {
    const ordinal = index === undefined ? 0 : index
    if (!indexOf(ordinal)) { invalid('has an invalid content index'); return }
    let part = item.parts.get(ordinal)
    if (!part) { part = {item, index:ordinal}; item.parts.set(ordinal, part) }
    return part
  }
  function order(a: Part, b: Part): number | undefined {
    return a.item === b.item ? a.index - b.index : a.item.index !== undefined && b.item.index !== undefined ? a.item.index - b.item.index : undefined
  }
  function append(text: string, part?: Part) {
    if (!text) return
    if (part) {
      if (lastPart && (order(part, lastPart) ?? 0) < 0) { invalid('would insert into previously emitted output'); return }
      part.first ??= length
      part.possibleStart ??= bareStart ?? length
      part.last = length + text.length
      lastPart = part; bareStart = undefined
    } else { bareStart ??= length }
    const last = chunks.at(-1)
    // Do not extend a run whose prefix was already inspected by a snapshot.
    // Normal delta streams retain one rope per contiguous address.
    if (last && last.part === part && last.start >= checkedThrough) last.text += text
    else chunks.push({start:length, text, part})
    length += text.length
  }
  function chunkAt(offset: number) {
    let low = 0, high = chunks.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2), chunk = chunks[middle]!
      if (chunk.start + chunk.text.length <= offset) low = middle + 1
      else high = middle
    }
    return low
  }
  function seal(part: Part, text: string): string {
    if (part.final !== undefined) {
      if (part.final !== text) invalid('changed a finalized content part')
      return ''
    }
    let start = part.first === undefined ? checkedThrough : Math.max(part.possibleStart!, Math.min(checkedThrough, part.first))
    let pos = chunkAt(start)
    // An earlier indexed part can legitimately have streamed without any
    // separate done event on compatible servers.
    while (pos < chunks.length) {
      const prior = chunks[pos]!
      if (!prior.part || (order(prior.part, part) ?? 0) >= 0) break
      start = prior.start + prior.text.length; pos++
    }
    const end = start + text.length, available = Math.min(length, end)
    if (part.last !== undefined && part.last > end) { invalid('finalized to a shorter value than its deltas'); return '' }
    let at = start
    while (at < available) {
      const chunk = chunks[pos++]!, stop = Math.min(available, chunk.start + chunk.text.length)
      if (chunk.part && chunk.part !== part || !text.startsWith(chunk.text.slice(at - chunk.start, stop - chunk.start), at - start)) {
        invalid('snapshot conflicts with emitted content'); return ''
      }
      at = stop
    }
    const suffix = text.slice(available - start)
    if (suffix) append(suffix, part)
    if (error) return ''
    if (end < length && !chunks[chunkAt(end)]?.part) unresolvedThrough = Math.max(unresolvedThrough, length)
    part.final = text
    checkedThrough = Math.max(checkedThrough, end)
    return suffix
  }
  function layout(item: Item, value: unknown): (string | null)[] | undefined {
    if (!Array.isArray(value)) { invalid('message lacks a content array'); return }
    const parts: (string | null)[] = []
    for (const part of value) {
      if (record(part) && part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text)
      else if (record(part) && part.type === 'refusal') parts.push(null)
      else { invalid('message contains an invalid content part'); return }
    }
    for (const [ordinal, part] of item.parts) {
      const snapshot = parts[ordinal]
      if (snapshot == null || part.final !== undefined && snapshot !== part.final || part.waitingFinal !== undefined && part.waitingFinal !== snapshot) { invalid('message contradicts a content part'); return }
      if (part.waiting && !snapshot.startsWith(part.waiting.join(''))) { invalid('snapshot conflicts with buffered content'); return }
    }
    if (item.layout && (item.layout.length !== parts.length || item.layout.some((text,i) => text !== parts[i]))) {
      invalid('changed a finalized message'); return
    }
    return parts
  }
  const asEvent = (text: string): LLMStreamEvent[] => !error && text ? [{type:'text/chunk',text}] : []
  function flushParts(item: Item): LLMStreamEvent[] {
    const emitted: LLMStreamEvent[] = []
    while (!error) {
      const part = item.parts.get(item.next)
      if (!part) break
      if (part.waitingFinal !== undefined) {
        const full = part.waitingFinal
        if (part.waiting && !full.startsWith(part.waiting.join(''))) { invalid('snapshot conflicts with buffered content'); break }
        part.waiting = undefined; part.waitingFinal = undefined
        emitted.push(...asEvent(seal(part,full)))
        item.next++
      } else {
        if (part.waiting) {
          const text = part.waiting.join('')
          part.waiting = undefined
          append(text,part)
          emitted.push(...asEvent(text))
        }
        break
      }
    }
    return emitted
  }
  function finalizePart(part: Part, text: string): LLMStreamEvent[] {
    const finalized = part.final ?? part.waitingFinal
    if (finalized !== undefined) {
      if (finalized !== text) invalid('changed a finalized content part')
      return []
    }
    part.waitingFinal = text
    return part.index === part.item.next ? flushParts(part.item) : []
  }
  return {
    /** Some compatible streams end without any done snapshots. At that
     * boundary an observed part is complete, but an absent earlier part
     * cannot be inferred. Release only consecutive observed parts. */
    drain(): LLMStreamEvent[] {
      if (error) return []
      const emitted: LLMStreamEvent[] = []
      for (const item of items) {
        while (item.parts.has(item.next)) {
          for (const event of flushParts(item)) emitted.push(event)
          if (error) return []
          if (item.parts.has(item.next)) item.next++
        }
        for (const part of item.parts.values()) if (part.index >= item.next) {
          invalid('is missing preceding content parts'); return []
        }
      }
      return emitted
    },
    delta(event: Record<string, unknown>): LLMStreamEvent[] {
      if (error) return []
      if (typeof event.delta !== 'string') { invalid('delta is not a string'); return [] }
      if (event.output_index === undefined && event.item_id === undefined && event.content_index === undefined) {
        append(event.delta); return asEvent(event.delta)
      }
      const item = bind(event.output_index, event.item_id), part = item && partAt(item,event.content_index)
      if (!part) return []
      if (event.delta && (part.final !== undefined || part.waitingFinal !== undefined || item.layout)) { invalid('has a delta after a finalized part'); return [] }
      if (part.index > item.next) {
        if (event.delta) (part.waiting ??= []).push(event.delta)
        return []
      }
      append(event.delta, part)
      return asEvent(event.delta)
    },
    partDone(event: Record<string, unknown>): LLMStreamEvent[] {
      if (error) return []
      let text = event.text
      if (event.type === 'response.content_part.done') {
        if (!record(event.part) || event.part.type !== 'output_text') return []
        text = event.part.text
      }
      if (typeof text !== 'string') { invalid('done event lacks final text'); return [] }
      const item = bind(event.output_index, event.item_id, true), part = item && partAt(item,event.content_index)
      if (!part) return []
      if (item.layout && item.layout[part.index] !== text) { invalid('part contradicts a finalized message'); return [] }
      return finalizePart(part,text)
    },
    message(index: unknown, message: Record<string, unknown>): LLMStreamEvent[] {
      if (error || message.role !== 'assistant') return []
      const item = bind(index, message.id, true), parts = item && layout(item,message.content)
      const result: LLMStreamEvent[] = []
      if (!item || !parts) return result
      for (const [ordinal, text] of parts.entries()) {
        if (text !== null) for (const event of finalizePart(partAt(item,ordinal)!,text)) result.push(event)
        else if (ordinal === item.next) { item.next++; for (const event of flushParts(item)) result.push(event) }
      }
      item.layout = parts
      return error ? [] : result
    },
    terminal(output: readonly unknown[]): Map<number, string> {
      const suffixes = new Map<number,string>()
      if (error) return suffixes
      const expected = new Map<Part, { start:number; text:string }>(), included = new Set<Item>(), texts: string[] = []
      let size = 0
      for (const [index, raw] of output.entries()) {
        if (!record(raw)) { invalid('has an invalid final output item'); return suffixes }
        if (raw.type !== 'message' || raw.role !== 'assistant') {
          if (byIndex.has(index) || typeof raw.id === 'string' && byId.has(raw.id)) { invalid('final item changed type'); return suffixes }
          continue
        }
        const item = bind(index,raw.id), parts = item && layout(item,raw.content)
        if (!item || !parts) return suffixes
        included.add(item)
        item.layout = parts
        for (const [ordinal,text] of parts.entries()) if (text !== null) {
          expected.set(partAt(item,ordinal)!,{start:size,text})
          texts.push(text); size += text.length
        }
      }
      // With no item ID or index, bind only when the completed response gives
      // a unique matching message. Identical text alone cannot pick two owners.
      let anonymousTarget: Item | undefined
      if (anonymous && !included.has(anonymous)) {
        for (const candidate of included) {
          const parts = candidate.layout!
          if (anonymous.layout && (anonymous.layout.length !== parts.length || anonymous.layout.some((text,i) => text !== parts[i]))) continue
          let matches = true
          for (const [ordinal, part] of anonymous.parts) {
            const concrete = candidate.parts.get(ordinal), span = concrete && expected.get(concrete)
            if (!span || part.final !== undefined && part.final !== span.text || part.waitingFinal !== undefined && part.waitingFinal !== span.text ||
                part.waiting && !span.text.startsWith(part.waiting.join('')) || part.first !== undefined && part.first < span.start ||
                part.last !== undefined && part.last > span.start + span.text.length) { matches = false; break }
          }
          if (matches) {
            if (anonymousTarget) { invalid('anonymous content matches multiple final messages'); return suffixes }
            anonymousTarget = candidate
          }
        }
        if (anonymousTarget) included.add(anonymous)
      }
      for (const item of items) if (!included.has(item)) { invalid('final output omitted an observed message'); return suffixes }
      const full = texts.join('')
      for (const chunk of chunks) {
        const target = chunk.part && (chunk.part.item === anonymous && anonymousTarget ? anonymousTarget.parts.get(chunk.part.index) : chunk.part)
        const span = target && expected.get(target)
        if (chunk.part && (!span || chunk.start < span.start || chunk.start + chunk.text.length > span.start + span.text.length) ||
            !full.startsWith(chunk.text,chunk.start)) { invalid('final output contradicts emitted content'); return suffixes }
      }
      if (length > size) { invalid('final output omitted visible content'); return suffixes }
      const priorLength = length, missing = new Map<number,string[]>()
      for (const [part, span] of expected) {
        const suffix = span.text.slice(Math.max(0,priorLength - span.start))
        if (suffix) {
          append(suffix,part)
          if (error) return suffixes
          const index = part.item.index!, list = missing.get(index) ?? []
          list.push(suffix); missing.set(index,list)
        }
        part.final = span.text; part.waiting = undefined; part.waitingFinal = undefined
      }
      for (const item of included) if (item.layout) item.next = item.layout.length
      checkedThrough = length
      if (anonymousTarget && anonymous) for (const part of anonymous.parts.values()) {
        part.final = anonymousTarget.layout![part.index]!
        part.waiting = undefined; part.waitingFinal = undefined
        anonymous.next = anonymousTarget.next
      }
      for (const [index,parts] of missing) suffixes.set(index,parts.join(''))
      return suffixes
    },
    get error() {
      if (error) return error
      if (checkedThrough < unresolvedThrough) return 'OpenAI response text has unattributed bytes beyond a finalized part'
      for (const item of items) for (const part of item.parts.values()) if (part.waiting?.length || part.waitingFinal !== undefined)
        return 'OpenAI response text is missing preceding content parts'
    },
  }
}
