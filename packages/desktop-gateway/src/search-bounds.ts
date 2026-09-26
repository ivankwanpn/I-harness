import type { SearchHit } from "@i-harness/session-query"

export function boundSearchHits(input: SearchHit[]): { hits: SearchHit[]; truncated?: true } {
  const hits: SearchHit[] = []
  let truncated = false
  for (const hit of input) {
    let snippet = ""
    let bytes = 0
    for (const char of hit.snippet) {
      bytes += Buffer.byteLength(char, "utf8")
      if (bytes > 512) { truncated = true; break }
      snippet += char
    }
    const row = { ...hit, snippet }
    if (Buffer.byteLength(JSON.stringify({ hits: [...hits, row], truncated: true }), "utf8") > 16384) {
      truncated = true
      break
    }
    hits.push(row)
  }
  return { hits, ...(truncated ? { truncated: true as const } : {}) }
}
