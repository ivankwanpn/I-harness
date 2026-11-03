import { afterEach, expect, it, vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry, resultExecution } from '@i-harness/core-tools'
import type { ExecService } from '@i-harness/exec'
import { createFsSearchTools, type SearchResult } from '../src/index.ts'
import * as engine from '../src/model-search.ts'
import { normalizeSearchQuery, createSearchResult } from '../src/options.mjs'

afterEach(() => vi.restoreAllMocks())

// The controlled runner supplies its own closed SearchResult. The genuine
// factory and registry dispatch retain responsibility for execution facts.
it.each([
  ['completed', 'succeeded'], ['limited', 'succeeded'], ['cancelled', 'canceled'],
  ['error', 'failed'], ['timed-out', 'failed'],
] as const)('declares its own %s receipt as %s without rewriting the returned data', async (status, outcome) => {
  const value: SearchResult = { ...createSearchResult(normalizeSearchQuery({pattern:'needle'})), status, partial: status !== 'completed', error: 'ordinary producer field', matches: [{path:'error.txt',line:1,text:'status: failed'}] }
  vi.spyOn(engine, 'runScopedModelSearch').mockResolvedValue(value)
  const [glob, grep] = createFsSearchTools({exec:{} as ExecService, workspace:process.cwd()})
  for (const tool of [glob!, grep!]) {
    const registry = createToolRegistry(createContext())
    registry.register(tool)
    const prepared = await registry.prepare({name:tool.name,args:{pattern:'needle'}})
    expect(await registry.dispatch(prepared)).toBe(value)
    expect(resultExecution(prepared)).toEqual({outcome,dispatch:'dispatched'})
    // Historical direct factory execution has no registered fact identity.
    expect(await tool.execute({pattern:'needle'}, {})).toBe(value)
  }
})
