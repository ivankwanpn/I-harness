import {expect,it} from 'vitest'
import {readFile} from 'node:fs/promises'
import * as browser from '../src/observation-snapshot.js'
it('browser subpath exposes only decoders and its source closure has no Node/host runtime imports',async()=>{
 expect(Object.keys(browser).sort()).toEqual(['decodeLegacyUsageView','decodeUsageSnapshotV2'])
 for(const name of ['observation-snapshot','observation-snapshot-decode','observation-snapshot-types','observation-projection-types','observation-types','types']){
  const source=await readFile(new URL('../src/'+name+'.ts',import.meta.url),'utf8')
  expect(source).not.toMatch(/(?:from\s*|import\s*\()\s*['"]node:/)
  expect(source).not.toMatch(/import\s+(?!type\b)[^;\n]*from\s*['"][^'"]*(?:store|aggregate|reducer|observation-codec)/)
 }
})
