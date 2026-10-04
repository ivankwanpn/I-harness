import { resolve } from 'node:path'
import { normalizeSearchQuery, createSearchStats } from '@i-harness/fs-search'
import { createPinnedProjectContentReader, type ProjectContentBudget } from './project-content-reader.ts'
import { projectRelativePath } from './project-files.ts'

export interface NativeReferenceSource { id: string; path: string; label: string }
export interface NativeCodeSourceReaderOptions {
  workspace: string
  references(): NativeReferenceSource[]
  authorize(sessionId: string, sourceId: string): Promise<boolean>
  config?(): ReaderConfig
}
interface Access { sessionId: string; signal?: AbortSignal }
interface ReaderConfig { maxFiles: number; maxFileBytes: number; maxInputBytes: number; ignorePatterns: string[] }
interface Snapshot { sourceId: string; path: string; revision: string; text: string; complete: boolean }
interface Hit { sourceId: string; path: string; revision: string }
const sourceKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const extensions = '**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,py,rs,go,java,c,cpp,h,hpp,cs,php,rb,swift,kt,scala,sh,ps1,sql,vue,svelte,css,scss,html,md,json,yaml,yml,toml}'

/** All source bytes are read from pinned handles under human-selected roots.
 * The reader creates no data/configuration files in any source directory. */
export function createNativeCodeSourceReader(options: NativeCodeSourceReaderOptions) {
  let last = { partial: false, reasons: [] as string[] }
  let previousConfig: ReaderConfig = {maxFiles:20000,maxFileBytes:1024*1024,maxInputBytes:128*1024*1024,ignorePatterns:[]}
  function sources(): NativeReferenceSource[] {
    const result = [{ id: 'workspace', path: options.workspace, label: 'Workspace' }, ...options.references().map(source => ({ ...source }))]
    if (new Set(result.map(source => source.id)).size !== result.length) throw new Error('Duplicate native source identity')
    return result
  }
  async function admitted(access: Access, source: NativeReferenceSource) {
    access.signal?.throwIfAborted()
    if (!access.sessionId || !await options.authorize(access.sessionId, source.id)) throw new Error('Code Context source is unavailable to this session')
    const current = sources().find(item => item.id === source.id)
    if (!current || sourceKey(current.path) !== sourceKey(source.path)) throw new Error('Code Context source changed')
    access.signal?.throwIfAborted()
  }
  function budget(config: ReaderConfig): ProjectContentBudget {
    return { maxCandidates: config.maxFiles + 1, maxFileBytes: config.maxFileBytes, maxInputBytes: config.maxInputBytes,
      stats: createSearchStats(), reserved: 0, entries: 0, pathBytes: 0, policyFiles: 0,
      reasons: new Set(), diagnostics: [], maxEntries: Math.min(100000,config.maxFiles*4), maxPolicyFiles: 128, maxCandidateBytes: 4*1024*1024 }
  }
  function decode(bytes: Buffer): string {
    const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8'
    const text = new TextDecoder(encoding,{fatal:true}).decode(bytes)
    if (text.includes('\0')) throw new Error('Binary source')
    return text
  }
  return {
    status: () => ({ partial: last.partial, reasons: [...last.reasons] }),
    async *snapshots(access: Access, input: { sourceIds?: string[]; config: ReaderConfig }): AsyncIterable<Snapshot> {
      last = { partial:false,reasons:[] }
      previousConfig={...input.config,ignorePatterns:[...input.config.ignorePatterns]}
      const all = sources(), requested = input.sourceIds === undefined ? all : input.sourceIds.map(id => {
        const source=all.find(item=>item.id===id); if(!source) throw new Error('Unknown Code Context source'); return source
      })
      const capturedBudget = budget(input.config)
      const signal = access.signal ?? new AbortController().signal
      const query = normalizeSearchQuery({pattern:'.',includes:[extensions],excludes:input.config.ignorePatterns,hidden:false,respectIgnore:true})
      try {
        for (const source of requested) {
          await admitted(access,source)
          const reader = await createPinnedProjectContentReader(source.path,capturedBudget,signal)
          try {
            const candidates = await reader.candidates(query)
            for await (const file of reader.snapshots(candidates)) {
              await admitted(access,source)
              let text: string
              try { text=decode(file.bytes) } catch { capturedBudget.reasons.add('non-text-source'); continue }
              yield {sourceId:source.id,path:file.path,revision:file.revision,text,complete:file.eof}
            }
            await admitted(access,source)
            await reader.checkRoot()
          } finally { await reader.close() }
        }
      } finally { last={partial:capturedBudget.reasons.size>0,reasons:[...capturedBudget.reasons]} }
    },
    async revalidate(access: Access, hit: Hit): Promise<boolean> {
      const source = sources().find(item=>item.id===hit.sourceId)
      if (!source) return false
      try {
        projectRelativePath(hit.path); await admitted(access,source)
        // Query admission checks the entire permitted file revision, not just
        // the displayed excerpt. This independent read never changes job stats.
        const currentConfig=options.config?.() ?? previousConfig
        const checkedBudget = budget({...currentConfig,maxFiles:1,maxInputBytes:currentConfig.maxFileBytes+128*64*1024})
        const reader=await createPinnedProjectContentReader(source.path,checkedBudget,access.signal ?? new AbortController().signal)
        try {
          const literalPath=hit.path.replace(/[\\*?\[\]{}()!+@]/g,'\\$&')
          const query=normalizeSearchQuery({pattern:'.',includes:[literalPath],excludes:currentConfig.ignorePatterns,hidden:false,respectIgnore:true})
          const permitted=await reader.candidates(query)
          if(!permitted.includes(hit.path)) return false
          const file=await reader.read(hit.path,checkedBudget.maxFileBytes,false,false)
          await admitted(access,source); await reader.checkRoot()
          return Boolean(file?.eof && file.revision===hit.revision)
        } finally { await reader.close() }
      } catch (error) { if(access.signal?.aborted) throw error; return false }
    },
  }
}
