import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Test-only guard, called before dynamic product imports. The actual gate
 * uses <outer>/<gate>/fixtures/structure, so inspect all ancestors as well. */
export function structureEvidence(fallback: string): string {
  if (!process.env.IH_CONFIG_DIR) throw Error('Structure evidence requires shell-isolated IH_CONFIG_DIR')
  const evidence = resolve(process.env.IH_STRUCTURE_EVIDENCE_ROOT ?? fallback)
  for (let path = evidence; ; path = dirname(path)) {
    if (existsSync(join(path, 'evidence-seal.json'))) throw Error(`Structure evidence sealed: ${path}`)
    if (dirname(path) === path) break
  }
  return evidence
}
