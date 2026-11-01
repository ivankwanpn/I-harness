import type { SessionView as Session, RuntimeContextFactSource, RuntimeContextRecordV1, CapturedActionFact, ProducerFactOutcome } from '@i-harness/core-session'
import { committedFactSeqs, createNondurableFactOwner, isNondurableSession, projectCurrentContext, runtimeContextDigest, renderRuntimeContext, validRuntimeContextRecord } from '@i-harness/core-session'
import { readRestoredConversation, type PreparedConversationArchive } from '@i-harness/core-session/internal/restoration'
import {types as utilTypes} from 'node:util'

export const RUNTIME_CONTEXT_SOURCE_PLUGIN = 'i-harness/runtime-context'
export const RUNTIME_CONTEXT_CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'
export interface ContextSection { name: string; text: string }
interface RuntimeContextPublicationLease { release(): Promise<void> }
export interface RuntimeContextService {
  registerSection(name: string, getter: () => string): () => void
  render(signal?: AbortSignal, retain?: () => RuntimeContextPublicationLease): Promise<void>
  settleOriginals(): Promise<void>
  currentText(): string
  close(): Promise<void>
}

/** The source retains one original capture until its real disposition is known.
 * Complete observations enter the existing owner in invocation order. */
export function createRuntimeContext(session: Session, source?: RuntimeContextFactSource): RuntimeContextService {
  return createRuntimeContextEngine(()=>projectCurrentContext(session),source,!source&&isNondurableSession(session)?createNondurableFactOwner(session):undefined)
}
export interface PreparedRuntimeContextReader {
  readonly ownerSessionId: string
  prepare(signal?:AbortSignal):Promise<PreparedConversationArchive>
  assertCurrent():void
}
/** A real nominal archive supplies the current floor; no Session-shaped view. */
export function createPreparedRuntimeContext(reader:PreparedRuntimeContextReader,source:RuntimeContextFactSource):RuntimeContextService {
  if(!reader||utilTypes.isProxy(reader)||typeof source!=='function'||utilTypes.isProxy(source))throw TypeError('Original prepared runtime source required')
  const fields=Object.getOwnPropertyDescriptors(reader),keys=Reflect.ownKeys(fields)
  if(keys.length!==3||!['ownerSessionId','prepare','assertCurrent'].every(name=>keys.includes(name)&&fields[name]&&'value'in fields[name]!)||typeof fields.ownerSessionId!.value!=='string'||!fields.ownerSessionId!.value||typeof fields.prepare!.value!=='function'||typeof fields.assertCurrent!.value!=='function'||utilTypes.isProxy(fields.prepare!.value)||utilTypes.isProxy(fields.assertCurrent!.value))throw TypeError('Closed prepared runtime reader required')
  const originalAssert=fields.assertCurrent!.value!,originalPrepare=fields.prepare!.value!
  const current=()=>{const now=Object.getOwnPropertyDescriptors(reader);if(Reflect.ownKeys(now).length!==keys.length||keys.some(key=>typeof key!=='string'||!now[key]||!('value'in now[key]!)||now[key]!.value!==fields[key]!.value))throw TypeError('Prepared runtime reader changed');Reflect.apply(originalAssert,reader,[])}
  const captured:PreparedRuntimeContextReader=Object.freeze({ownerSessionId:fields.ownerSessionId!.value,prepare(signal?:AbortSignal){current();return Reflect.apply(originalPrepare,reader,[signal])},assertCurrent:current})
  return createRuntimeContextEngine(()=>{throw TypeError('Original prepared context required')},source,undefined,captured)
}
function createRuntimeContextEngine(readCurrent:()=>{readonly semanticDigest:string}|undefined,source?:RuntimeContextFactSource,memory?:ReturnType<typeof createNondurableFactOwner>,prepared?:PreparedRuntimeContextReader):RuntimeContextService {
  const sections = new Map<string, () => string>()
  let accepting = true, closed = false
  type Flight = { work: Promise<void>; records: Set<Publication> }
  type Publication = { capture?: CapturedActionFact<ProducerFactOutcome>; action: ReturnType<RuntimeContextFactSource>; lease?: RuntimeContextPublicationLease;
    outcome?: ProducerFactOutcome; finished: boolean; finishFailure?: { error: unknown }; leaseReleased: boolean; settled: boolean; finishNeeded: boolean; cleanup?: Promise<void> }
  const originals = new Set<Publication>(), flights = new Set<Flight>()
  let adjacent: { digest: string; signal?: AbortSignal; action: ReturnType<RuntimeContextFactSource>; work: Promise<void> } | undefined
  let preparedTail:Promise<unknown>=Promise.resolve()
  const captureSections = (): RuntimeContextRecordV1 => {
    const snapshot: ContextSection[] = []
    for (const [name, getter] of sections) {
      const text = getter().trim()
      if (text) snapshot.push({ name, text })
    }
    const record: RuntimeContextRecordV1 = { type: 'runtime/context', version: 1, sections: snapshot }
    if (!validRuntimeContextRecord(record)) throw new TypeError('Invalid runtime context sections')
    return record
  }
  const terminal = (outcome: ProducerFactOutcome | undefined) => !!outcome && ['committed', 'memory-committed', 'absent', 'not-issued'].includes(outcome.kind)
  function complete(original: Publication): Promise<void> {
    if (original.cleanup) return original.cleanup
    const cleanup = Promise.resolve().then(async () => {
      if (!original.finished) {
        original.finished = true
        if (original.finishNeeded) try { original.action.finish() }
        catch (error) { original.finishFailure = { error } }
      }
      if (original.finishFailure) throw original.finishFailure.error
      if (original.lease && !original.leaseReleased) { await original.lease.release(); original.leaseReleased = true }
      originals.delete(original)
    })
    original.cleanup = cleanup
    void cleanup.catch(() => { if (original.cleanup === cleanup) original.cleanup = undefined })
    return cleanup
  }
  async function reconcileRecords(records: readonly Publication[]): Promise<ProducerFactOutcome[]> {
    const refused: ProducerFactOutcome[] = [], errors: unknown[] = []
    for (const original of records) {
      try {
        if (original.capture && !terminal(original.outcome)) original.outcome = await original.capture.reconcile()
        if (original.capture && !terminal(original.outcome)) committedFactSeqs(original.outcome!)
        await complete(original)
        if (original.outcome?.kind === 'absent' || original.outcome?.kind === 'not-issued') refused.push(original.outcome)
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Original runtime publication settlement failed')
    return refused
  }
  async function settleOriginals() {
    // Finite ownership snapshot. A concurrently accepted later render keeps
    // its own records/lease; this management call never chases the live Set.
    const accepted = [...flights], records = new Set(originals)
    await Promise.allSettled(accepted.map(flight => flight.work))
    for (const flight of accepted) for (const original of flight.records) records.add(original)
    await reconcileRecords([...records])
  }
  function publish(record: RuntimeContextRecordV1, flight: Flight, signal?: AbortSignal, retain?: () => RuntimeContextPublicationLease, current=readCurrent, guard?:()=>void): Promise<void> {
    signal?.throwIfAborted()
    const latest = current()
    if ((prepared||flights.size === 1 && flights.has(flight)) && latest?.semanticDigest === runtimeContextDigest(record.sections)) return Promise.resolve()
    const digest = runtimeContextDigest(record.sections)
    const action = source ? source(signal) : adjacent && adjacent.signal === signal ? adjacent.action : memory?.beginAction(signal)
    if (!action) throw Object.assign(new Error('Managed runtime context requires its owned source'), { code: 'FACT_OWNER_UNSUPPORTED' })
    if (adjacent?.digest === digest && adjacent.signal === signal && adjacent.action === action) return adjacent.work
    const publication: Publication = { action, finished: false, leaseReleased: false, settled: false,
      finishNeeded: ![...originals].some(original => original.action === action) }
    originals.add(publication); flight.records.add(publication)
    let work: Promise<void>
    try {
      publication.lease = retain?.()
      publication.capture = action.captureRuntimeContext(record, () => {if(closed)return false;try{guard?.();return true}catch{return false}})
      publication.finishNeeded = true
      work = publication.capture.admit().then(async outcome => {
        publication.outcome = outcome
        if (terminal(outcome)) await complete(publication)
        committedFactSeqs(outcome)
        signal?.throwIfAborted()
      })
    } catch (failure) {
      work = complete(publication).then(() => { throw failure }, saving => { throw new AggregateError([failure, saving], 'Runtime publication setup and cleanup failed', { cause: failure }) })
    }
    work = work.finally(() => { publication.settled = true })
    adjacent = { digest, signal, action, work }
    const settled = () => { if (adjacent?.work === work) adjacent = undefined }
    void work.then(settled, settled)
    return work
  }
  async function publishPrepared(record:RuntimeContextRecordV1,flight:Flight,signal?:AbortSignal,retain?:()=>RuntimeContextPublicationLease):Promise<void>{
    if(!accepting)throw Error('Runtime context closed')
    signal?.throwIfAborted();prepared!.assertCurrent()
    const archive=await prepared!.prepare(signal)
    try{
      const current=()=>{if(!accepting)throw Error('Runtime context closed');signal?.throwIfAborted();prepared!.assertCurrent();archive.assertCurrent()}
      current()
      const floor=readRestoredConversation(archive,{ownerSessionId:prepared!.ownerSessionId}).projection.current
      return await publish(record,flight,signal,retain,()=>{current();return floor},current)
    }finally{await archive.settle()}
  }
  return {
    registerSection(name, getter) {
      if (!accepting) throw new Error('Runtime context closed')
      if (!validRuntimeContextRecord({ type: 'runtime/context', version: 1, sections: [{ name, text: '' }] })) throw new TypeError('Invalid runtime context section name')
      if (sections.has(name)) throw new Error('duplicate runtime-context section: ' + name)
      sections.set(name, getter)
      return () => { if (sections.get(name) === getter) sections.delete(name) }
    },
    currentText: () => renderRuntimeContext(captureSections().sections),
    render(signal, retain) {
      if (!accepting) return Promise.reject(new Error('Runtime context closed'))
      const record = captureSections()
      const finished = Promise.withResolvers<void>(), flight: Flight = { work: finished.promise, records: new Set() }
      void finished.promise.catch(() => {})
      flights.add(flight)
      // Capture/admit synchronously under the original source and signal.
      // An uncertain previous publication must first resolve its SAME capture.
      let work: Promise<void>
      const proceed=()=>{
      const pending = [...originals].filter(original => original.settled)
      const publishOriginal=()=>prepared?publishPrepared(record,flight,signal,retain):publish(record,flight,signal,retain)
      return pending.length ? reconcileRecords(pending).then(refused => {
        if (refused.length) committedFactSeqs(refused[0]!)
        return publishOriginal()
      }) : publishOriginal()
      }
      try { if(prepared){work=preparedTail.then(proceed);preparedTail=work.catch(()=>{})}else work=proceed() }
      catch (error) { work = Promise.reject(error) }
      void work.then(() => { flights.delete(flight); finished.resolve() }, error => { flights.delete(flight); finished.reject(error) })
      return work
    },
    settleOriginals,
    async close() {
      accepting = false
      await settleOriginals()
      closed = true
    },
  }
}
