#!/usr/bin/env node
// scripts/audit/annotate-d3-verification.mjs
//
// Records, durably beside the verification result itself, which of the
// verifier's verdicts did NOT survive re-checking -- and why.
//
// This matters more than it looks. An adversarial verification pass is only
// useful if its OWN errors are visible: three rounds of this audit have now
// found stale or invented line numbers in the extracts at a rate of zero, while
// the verifiers themselves have produced two wrong corrections (a codex
// /logout path missing its `chatwidget/` segment in D2, and here a claim
// misread as asserting something it does not assert). Leaving the tally
// unannotated would let a reader treat six WRONG_LINE verdicts as six broken
// rows, which re-checking shows is not the case.

import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(process.argv[1], "../../..")
const P = join(ROOT, "docs/audit/data/2026-09-13-d3-verification.json")
const doc = JSON.parse(readFileSync(P, "utf8"))

doc._recheckedByParent = {
  date: "2026-09-13",
  note:
    "Each WRONG_LINE and PARTIAL verdict was re-checked against the current source files. Results below. The tally is unchanged; only its interpretation is corrected.",
  actionableAndFixed: [
    {
      cell: "cc-custom / bun:bundle feature gates",
      finding: "cited package.json:115-121 (the npm scripts block) and understated the counts",
      action:
        "citation moved to a real call site; counts replaced with the measured figures (153 importing files, 556 feature() call sites, 68 distinct flags, against the claimed ~499/~70)",
    },
  ],
  verdictWasItselfWrong: [
    {
      cell: "dsh / team-roster-identity-and-provisioning",
      verifierSaid:
        "the claim asserts identity is granted 'only for phase active' and omits a 'lead' identity, so its negative is false",
      actually:
        "the claim already reads \"grants a teammate identity only for a durable member row in phase 'active' or 'provisioning'\" and already states \"a descriptor-less root becomes an implicit Lead\". No edit was made, because the prose was already correct.",
      whyItMatters:
        "this is the second verifier correction in this audit that did not survive re-checking. Verifier output is evidence, not authority.",
    },
  ],
  secondaryCitationArtifact: {
    count: 5,
    note:
      "The remaining five WRONG_LINE verdicts were all about a SECONDARY citation. The sampler emits one cell per citation in a claim's evidence array, so a claim with eight citations offers eight chances to be flagged, while the matrix displays bestCitation() -- which leads with an implementation-class line. In every one of those five cases the published row already led with a correct locus. The document is therefore in better shape than '6 of 21 failed' suggests, and the sampler's per-citation granularity is the reason the raw tally reads worse than the artifact is.",
    notFixed:
      "The sampler was deliberately NOT changed to sample only leading citations. Doing so would make the next round's number look better than this round's while the two would no longer be comparable; the definition is stated here instead.",
  },
}

writeFileSync(P, JSON.stringify(doc, null, 2) + "\n", "utf8")
JSON.parse(readFileSync(P, "utf8"))
console.log("annotated docs/audit/data/2026-09-13-d3-verification.json")
console.log(`  actionable and fixed : ${doc._recheckedByParent.actionableAndFixed.length}`)
console.log(`  verdict itself wrong : ${doc._recheckedByParent.verdictWasItselfWrong.length}`)
console.log(`  secondary-citation   : ${doc._recheckedByParent.secondaryCitationArtifact.count} of the 6 WRONG_LINE`)
