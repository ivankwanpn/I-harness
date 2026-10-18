import { streamJsonData, UnsupportedJsonData } from './json-stream.ts'

/** String wrappers share the result streaming traversal and native escaping. */
export function stringifyJsonData(value: unknown): string | undefined {
  let parts: string[]
  try { parts = [...streamJsonData(value, { dataOnly: true })] }
  catch (cause) {
    if (!(cause instanceof UnsupportedJsonData)) throw cause
    parts = [...streamJsonData(value)]
  }
  return parts.length ? parts.join('') : undefined
}

/** Canonical encoding is used only after the owning DTO validator. */
export function canonicalJsonData(value: unknown): string {
  return [...streamJsonData(value, { lexical: true, dataOnly: true })].join('') || 'null'
}
