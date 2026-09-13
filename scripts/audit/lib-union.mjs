// scripts/audit/lib-union.mjs
//
// The union folding used by BOTH build-matrix.mjs and assemble-d2.mjs. It lives
// in one place because the two scripts previously carried hand-synced copies and
// the logic has already needed correcting twice.
//
// The union is the load-bearing step of the whole audit: every parity cell in the
// final document is produced here, so the rules have to be explicit.
//
// Rule 1 -- merge on the normalised `canonical` name. Normalisation is
// deliberately shallow (case, separators, the dsh `command-` package prefix).
// Anything semantic is NOT normalised, because that is exactly the kind of guess
// that silently merges two different commands.
//
// Rule 2 -- a source may NOT occupy the same row twice. If two of a source's
// commands normalise to the same key, one of them would overwrite the other and
// a command would vanish from the matrix without a trace. When that happens the
// later command is re-keyed under its own raw name and the collision is recorded
// in `collisions` for the document. (Measured case: codex's `Btw` and `Side`
// were both canonicalised to `side-conversation`; blindly merging them dropped a
// real command AND cost I-harness's own `/btw` row its codex cell.)
//
// Rule 3 -- crossSourceHints merge a row only when a source explicitly claims
// the mapping, and never delete a row that another source already occupies.

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

export const SOURCES = [
  { key: "ih", label: "IH" },
  { key: "dsh", label: "dsh" },
  { key: "codex", label: "codex" },
  { key: "opencode", label: "opencode" },
  { key: "opencode-fork", label: "ocode-fork" },
  { key: "grok", label: "grok" },
  { key: "cc-custom", label: "cc-custom" },
]

export const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/^command-/, "")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")

export function readJson(p) {
  if (!p || !existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

/** Load every source's enriched (preferred) or raw extraction. */
export function loadSources(dataDir) {
  const loaded = {}
  for (const { key } of SOURCES) {
    loaded[key] = {
      enriched: readJson(join(dataDir, `2026-09-11-${key}-enriched.json`)),
      raw: readJson(join(dataDir, `2026-09-11-${key}-commands.json`)),
    }
  }
  return loaded
}

/**
 * Is this string plausibly a COMMAND NAME? The `added` array is filled by
 * extraction agents, and an agent can misread the brief and put a prose
 * observation there instead of a command. Measured case: cc-custom's `added`
 * held seven sentences ("src/commands.ts is the single central registry for all
 * 67 commands ..."), each of which the union then turned into a phantom row.
 * A command name is short and has no spaces or path punctuation.
 */
export function isCommandName(s) {
  if (typeof s !== "string") return false
  const t = s.trim()
  if (!t || t.length > 40) return false
  if (/\s/.test(t)) return false
  if (/[/\\.(){}[\],;:'"`*]/.test(t)) return false
  return /^[a-z0-9][a-z0-9-]*$/i.test(t)
}

/**
 * Fold the per-source extractions into union rows.
 * Returns { rows, collisions, rejectedAdditions, interactionRows }.
 *
 * `interactionRows` are deliberately NOT folded into the union. dsh's RPC plane
 * (session.*, subagent.*, commands.list/execute) is a DIFFERENT LAYER from a
 * slash command; putting `execute` and `list` in the same table as `/compact`
 * would compare two unlike things and inflate dsh's column. They are returned
 * separately so D2 can render them as their own sub-table.
 */
export function buildUnion(loaded) {
  const rows = new Map()
  const collisions = []
  const rejectedAdditions = []
  const interactionRows = []

  const ensure = (key, cmd) => {
    if (!rows.has(key)) rows.set(key, { key, family: cmd?.family ?? null, perSource: {} })
    const r = rows.get(key)
    if (!r.family && cmd?.family) r.family = cmd.family
    return r
  }

  for (const { key: src } of SOURCES) {
    const b = loaded[src]
    if (!b) continue
    const list = [...(b.enriched?.commands ?? b.raw?.commands ?? [])]
    // `added` holds commands the source genuinely has but the mechanical
    // extractor missed (dsh registers three inline from domain packages).
    for (const a of b.enriched?.added ?? []) {
      if (typeof a === "string") {
        if (!isCommandName(a)) {
          rejectedAdditions.push({ source: src, value: a })
          continue
        }
        list.push({ rawName: a, canonical: a })
      } else if (a && typeof a === "object" && (a.rawName || a.canonical)) {
        list.push(a)
      } else {
        rejectedAdditions.push({ source: src, value: JSON.stringify(a).slice(0, 120) })
      }
    }
    for (const a of b.enriched?.interactionCommands ?? []) {
      if (a && typeof a === "object") interactionRows.push({ source: src, ...a })
    }

    for (const cmd of list) {
      if (!cmd || (!cmd.rawName && !cmd.canonical)) continue
      let key = norm(cmd.canonical || cmd.rawName)

      // Rule 2: never let one source occupy the same row twice.
      if (rows.has(key) && rows.get(key).perSource[src]) {
        const incumbentRow = rows.get(key)
        const incumbent = incumbentRow.perSource[src]
        const incumbentFallback = norm(incumbent.rawName)
        const displacedTo = norm(cmd.rawName)

        // The contested canonical is a name the extracting agent invented for
        // BOTH commands, so it is trustworthy for neither. Move the incumbent to
        // its own raw name -- creating that row or, importantly, REUSING it if it
        // already exists because another source has the same command (codex's
        // `Btw` belongs in the row I-harness's `/btw` already occupies).
        if (incumbentFallback && incumbentFallback !== key) {
          const dest = ensure(incumbentFallback, incumbent)
          if (!dest.perSource[src]) {
            dest.perSource[src] = incumbent
            delete incumbentRow.perSource[src]
            if (Object.keys(incumbentRow.perSource).length === 0) rows.delete(key)
          }
        }

        if (rows.has(displacedTo) && rows.get(displacedTo).perSource[src]) {
          collisions.push({
            source: src,
            canonical: key,
            displacedTo: null,
            names: [incumbent.rawName, cmd.rawName],
            unresolved: true,
          })
          continue
        }
        collisions.push({ source: src, canonical: key, displacedTo, names: [incumbent.rawName, cmd.rawName] })
        key = displacedTo
      }

      const row = ensure(key, cmd)
      row.perSource[src] = cmd

      // Rule 3: honour explicit cross-source hints, but never delete a row that
      // some other source already occupies.
      for (const h of (cmd.crossSourceHints ?? []).map(norm).filter(Boolean)) {
        if (h === key) continue
        const target = rows.get(h)
        if (!target || target === row) continue
        const targetOccupied = Object.keys(target.perSource).some((s) => s !== src)
        if (targetOccupied) continue
        for (const [s, v] of Object.entries(target.perSource)) if (!row.perSource[s]) row.perSource[s] = v
        rows.delete(h)
      }
    }
  }

  return { rows, collisions, rejectedAdditions, interactionRows }
}
