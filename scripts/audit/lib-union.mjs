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

/** Absolute roots, used to resolve a citation's line for carrier classification. */
export const SOURCE_PATHS = {
  ih: "D:/I-harness-main",
  dsh: "D:/agent-complete/deepseek-harness-dsh-v0.1.5-rc.2",
  codex: "D:/agent-complete/codex-rust-v0.149.1",
  opencode: "D:/agent-complete/opencode-1.18.30",
  "opencode-fork": "D:/agent-complete/opencode-fork-private-999.0.15",
  grok: "D:/agent-complete/grok-build-main",
  "cc-custom": "D:/opencode-bugfix/cc-custom",
}

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
    // The I-harness command extraction is named `ih-commands-enriched.json`
    // while every other source uses `<key>-enriched.json`. Looking only for the
    // latter silently fell back to the RAW extraction for I-harness, so the
    // whole IH column of the matrix was built from entries with `mechanism:
    // null` and no family -- the richest source in the audit rendered as its
    // emptiest. Both spellings are probed.
    const enriched =
      readJson(join(dataDir, `2026-09-11-${key}-enriched.json`)) ??
      readJson(join(dataDir, `2026-09-11-${key}-commands-enriched.json`))
    loaded[key] = {
      enriched,
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
 * Classify what KIND of thing a cited line is.
 *
 * Two rounds of adversarial verification found ZERO stale or invented line
 * numbers, yet 11 claims whose citation could not carry them. Every one was a
 * CARRIER failure, recurring in exactly three shapes: a bundle/manifest entry, a
 * registry or exports listing, and a sibling-file helper or bare alias
 * expression. Naming the class mechanically turns a finding that had to be
 * re-discovered each round into a number the document can report.
 *
 * Lives here, not in a script, because BOTH verify-citations.mjs (measuring the
 * data) and assemble-d2.mjs (choosing which citation to display) need it, and
 * hand-synced copies in this audit have already drifted once.
 *
 * This is a heuristic on the LINE, not a judgement about the claim.
 */
export function carrierClass(rel, lineText) {
  const t = (lineText ?? "").trim()
  const ext = (String(rel).match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase()
  if (["yml", "yaml", "toml", "json", "jsonl", "lock", "txt"].includes(ext)) return "manifest"
  if (/^(\/\/!|\/\/\/|\/\*\*|\*|#)/.test(t)) return "doc-comment"
  if (/^(pub )?(struct|enum|trait|type|interface)\b/.test(t)) return "type-decl"
  if (/^Arc::new\(|^-\s*id:|^\s*name:\s*["']|^\s*["'][^"']+["']\s*:|^export\s|"exports"|^\s*\.\.\.[A-Za-z]/.test(t))
    return "registry-listing"
  if (/^\s*(if|else|\})\s|^\s*&\[|^\s*self\.[a-z_]+\.[a-z_]+\(|^\s*return\s+self\./.test(t)) return "alias-or-helper"
  if (/^\s*$/.test(t)) return "blank"
  return "implementation"
}

/** Carrier classes that should not LEAD a mechanism claim (weak evidence). */
export const WEAK_CARRIERS = new Set(["manifest", "registry-listing", "alias-or-helper", "doc-comment", "type-decl", "blank"])

/**
 * Does a moduleCoverage map account for this module?
 *
 * Exact names are the precise case. PATTERNS are the important one: dsh ships 267
 * leaf packages and most are Cordis plumbing, so requiring a bespoke sentence for
 * each asks an agent to write 267 near-identical lines and buries the handful that
 * matter. A pattern such as `client/*` covering forty packages with one honest
 * statement is equally explicit evidence of coverage and leaves the agent's effort
 * for the modules that carry capability.
 *
 * `*` matches within one path segment, `**` matches across segments.
 */
export function coveragePatternToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
  return new RegExp(`^${escaped}$`)
}

export function coverageAccountsFor(cov, name) {
  if (!cov || typeof cov !== "object") return false
  if (Object.prototype.hasOwnProperty.call(cov, name)) return true
  for (const key of Object.keys(cov)) {
    if (!key.includes("*")) continue
    try {
      if (coveragePatternToRegExp(key).test(name)) return true
    } catch {
      /* an unparseable pattern simply does not match */
    }
  }
  return false
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
