// @i-harness/tui — M40 G2 (C12): mermaid Unicode diagram art (spec §8:
// Unicode diagram art replaces the fence body). renderMermaidArt(source,
// maxWidth) → { kind: "art" | "box"; lines }.
//
// SUBSET (documented — everything outside is the honest box fallback):
//   - header: `flowchart` / `graph` (direction word LR/TD/TB/RL is ignored —
//     the SUBSET always renders the spec's own left-to-right ladder).
//   - node defs: `A[text] | A((text)) | A(text) | A{text} | plain A` (a plain
//     node uses its id as the text). Node text clips to maxWidth-6 with a "…".
//   - edges: `A --> B` and `A --- B`; a line may chain (`A --> B --> C`).
//   - comments (`%%`) and blank lines are ignored.
// LAYOUT: ≤2 COLUMNS ladder. Ranks = longest path from the SOURCES (in-degree
// 0); even ranks → LEFT column (one node per row), odd ranks → RIGHT. Forward
// edges draw `──→ ` on the box row; a LOOP-BACK edge back to the left column
// draws ` ←──┘` on the target row (the A→B→C serpent) with `│` verticals
// between. Rank > 2, a cycle, unparseable lines or an over-width layout →
// box fallback.
// FALLBACK (unknown header / unparseable / too wide / too deep): the spec's
// box `╭ mermaid: <word> ─╮` + ONE hint line, both clipped to maxWidth.

export interface MermaidArt {
  kind: "art" | "box"
  lines: string[]
}

type NodeShape = "square" | "circle" | "round" | "brace" | "plain"

interface GraphModel {
  nodes: Map<string, { id: string; text: string; shape: NodeShape }>
  preds: Map<string, string[]>
  succs: Map<string, string[]>
  order: string[]
}

/** Box line `╭ {text} ─╮` (width = text.length + 5 — the spec §8 shape). */
function boxLine(text: string): string {
  return `╭ ${text} ─╮`
}

/** Clip to maxWidth-6 (spec §8 text clip) with a "…" tail. */
function clipText(text: string, maxWidth: number): string {
  const limit = Math.max(5, maxWidth - 6)
  if (text.length <= limit) return text
  return text.slice(0, Math.max(1, limit - 1)) + "…"
}

/* ------------------------------------------------------------------ parsing */

const NODE_DEFS: Array<[NodeShape, RegExp]> = [
  ["square", /^(\w+)\s*\[([^\]]*)\]$/],
  ["circle", /^(\w+)\s*\(\(([^)]*)\)\)$/],
  ["round", /^(\w+)\s*\(([^)]*)\)$/],
  ["brace", /^(\w+)\s*\{([^}]*)\}$/],
]

function parseNodeLine(line: string): { id: string; text: string; shape: NodeShape } | undefined {
  for (const [shape, re] of NODE_DEFS) {
    const m = re.exec(line)
    if (m !== null) return { id: m[1]!, text: m[2]!, shape }
  }
  if (/^\w+$/.test(line)) return { id: line, text: line, shape: "plain" }
  return undefined
}

const EDGE_RE = /(-->|---)/

/** An edge endpoint: a plain id or an INLINE node def (`B[text]`), the other
 * classic mermaid shape (`A[text] --> B((t))` — inline defs ride the edge). */
function parseEndpoint(seg: string): { id: string; text: string; shape: NodeShape } | undefined {
  const s = seg.trim()
  if (s === "") return undefined
  const def = parseNodeLine(s)
  return def ?? (/^\w+$/.test(s) ? { id: s, text: s, shape: "plain" } : undefined)
}

/** Edge line (may chain) → consecutive from→to pairs + inline endpoint nodes.
 * [] when not edge-shaped (or an endpoint is unparseable). */
function parseEdgeLine(line: string): { edges: Array<{ from: string; to: string }>; nodes: Array<{ id: string; text: string; shape: NodeShape }> } {
  const parts = line.split(EDGE_RE)
  if (parts.length < 3) return { edges: [], nodes: [] }
  const edges: Array<{ from: string; to: string }> = []
  const nodes: Array<{ id: string; text: string; shape: NodeShape }> = []
  for (let i = 0; i + 2 < parts.length; i += 2) {
    const from = parseEndpoint(parts[i]!)
    const to = parseEndpoint(parts[i + 2]!)
    if (from === undefined || to === undefined) return { edges: [], nodes: [] }
    edges.push({ from: from.id, to: to.id })
    nodes.push(from, to)
  }
  return { edges, nodes }
}

/** Drop comments/blank lines; detect the flowchart/graph header. */
function preprocess(source: string): { lines: string[]; isFlowchart: boolean } {
  const lines: string[] = []
  let isFlowchart = false
  for (const raw of source.split("\n")) {
    const line = raw.split("%%")[0]!.trim()
    if (line === "") continue
    if (!isFlowchart && /^(flowchart|graph)\b/i.test(line)) isFlowchart = true
    lines.push(line)
  }
  return { lines, isFlowchart }
}

function buildModel(lines: string[]): GraphModel | undefined {
  const g: GraphModel = { nodes: new Map(), preds: new Map(), succs: new Map(), order: [] }
  const addNode = (id: string, def?: { id: string; text: string; shape: NodeShape }): void => {
    if (g.nodes.has(id)) return // FIRST definition wins (declaration order)
    g.nodes.set(id, def ?? { id, text: id, shape: "plain" })
    g.order.push(id)
  }
  for (const line of lines) {
    const def = parseNodeLine(line)
    if (def !== undefined) {
      addNode(def.id, def)
      continue
    }
    const ev = parseEdgeLine(line)
    if (ev.edges.length === 0 && line.trim() !== "") return undefined // unparseable
    for (const n of ev.nodes) addNode(n.id, n)
    for (const { from, to } of ev.edges) {
      addNode(from)
      addNode(to)
      const p = g.preds.get(to) ?? []
      if (!p.includes(from)) p.push(from)
      g.preds.set(to, p)
      const s = g.succs.get(from) ?? []
      if (!s.includes(to)) s.push(to)
      g.succs.set(from, s)
    }
  }
  return g.order.length > 0 ? g : undefined
}

/* ------------------------------------------------------------------ ranks */

/** Longest-path ranks from the sources; undefined on cycle / too deep. */
function computeRanks(g: GraphModel): Map<string, number> | undefined {
  const ranks = new Map<string, number>()
  const sources = g.order.filter((id) => (g.preds.get(id)?.length ?? 0) === 0)
  const roots = sources.length > 0 ? sources : g.order
  const visiting = new Set<string>()
  const visit = (id: string, rank: number): boolean => {
    if (rank > 2) return false // too deep for the two-column ladder
    if (visiting.has(id)) return false // cycle
    if ((ranks.get(id) ?? -1) >= rank) return true
    ranks.set(id, rank)
    visiting.add(id)
    for (const t of g.succs.get(id) ?? []) {
      if (!visit(t, rank + 1)) return false
    }
    visiting.delete(id)
    return true
  }
  for (const r of roots) {
    if (!visit(r, 0)) return undefined
  }
  return ranks
}

/* ------------------------------------------------------------------ output */

function fallbackBox(word: string, hint: string, maxWidth: number): string[] {
  return [boxLine(clipText(`mermaid: ${word}`, maxWidth)), clipText(hint, maxWidth)]
}

/** The ladder renderer (see module header for the exact geometry). */
function renderLadder(g: GraphModel, maxWidth: number): MermaidArt {
  const ranks = computeRanks(g)
  if (ranks === undefined) {
    return { kind: "box", lines: fallbackBox("flowchart", "cycle or too deep for two columns", maxWidth) }
  }
  const left = g.order.filter((id) => (ranks.get(id) ?? 0) % 2 === 0)
  const right = g.order.filter((id) => (ranks.get(id) ?? 0) % 2 === 1)
  const boxOf = (id: string): string => boxLine(clipText(g.nodes.get(id)!.text, maxWidth))
  let w0 = 0
  for (const id of left) w0 = Math.max(w0, boxOf(id).length)
  let w1 = 0
  for (const id of right) w1 = Math.max(w1, boxOf(id).length)
  const connector = 5 // the `──→ ` lane
  if (w0 > 0 && w1 > 0 && w0 + connector + w1 > maxWidth) {
    const need = w0 + connector + w1
    return { kind: "box", lines: fallbackBox("flowchart", `diagram needs ${need} cols, limit ${maxWidth}`, maxWidth) }
  }
  const rows = Math.max(left.length, right.length)
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    const l = left[r]
    const rr = right[r]
    if (l !== undefined && rr !== undefined) {
      // forward lane on the box row (the arrow is decorative — the edge
      // topology already shaped the columns)
      lines.push(boxOf(l).padEnd(w0) + "──→ " + boxOf(rr))
      continue
    }
    if (l !== undefined) {
      // loop-back row: the node came from a right-column source above.
      const src = (g.preds.get(l) ?? []).find((p) => (ranks.get(p) ?? 0) % 2 === 1)
      lines.push(src !== undefined ? boxOf(l).padEnd(w0) + " ←──┘" : boxOf(l).padEnd(w0))
      continue
    }
    // right-only row: `└──→ ` lift from the left column's row above.
    lines.push(" ".repeat(w0) + "└──→ " + boxOf(rr!))
  }
  return { kind: "art", lines }
}

/** Render a mermaid fence body (see module header for the supported subset). */
export function renderMermaidArt(source: string, maxWidth: number): MermaidArt {
  const { lines, isFlowchart } = preprocess(source)
  const firstWord = /^([A-Za-z][\w-]*)/.exec(lines[0] ?? "")?.[1] ?? "diagram"
  if (!isFlowchart) {
    return { kind: "box", lines: fallbackBox(firstWord, "unsupported diagram type", maxWidth) }
  }
  const g = buildModel(lines.slice(1))
  if (g === undefined) {
    return { kind: "box", lines: fallbackBox("flowchart", "no parseable nodes", maxWidth) }
  }
  return renderLadder(g, maxWidth)
}
