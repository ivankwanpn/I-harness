# Transfer and pre-ready host primitives — scoped checkpoint

This records the approved **primitive gates**, not completed original R4B Task3 or working fork/spawn cutover. The next required gate is actual broker/coordinator/artifact composition from [Task3 of the active plan](../superpowers/plans/2026-10-23-context-transfer-host.md). Product remains0.1.13-rc.1 / Session11; no publication or decomposition credit.

| Scope | Original reviewed product | Correction | Main integration |
|---|---|---|---|
| Original-operation result transfer/v2/closure | e0196e85 | afd10203 | same commits |
| Coordinator host phase and genuine broker preparation |89fa8e07|ac2147b8|6dbf6a1c +1aa855b4|
| Audit generated-output inventory |32677ad1|none|8970f5e2|

All three scopes received fresh GPT6Astra reviews. Artifact review found two Important issues: ordinary target read authorization made pre-READY transfer circular; NEW source authorization could become denied during publication without invalidating success. Both were reproduced and fixed, and the same reviewer approved the correction. Host review found omitted/inherited optional preparation was not captured synchronously; actual JSONL reproduction and correction were approved by the same reviewer. New APIs still need genuine connected composition and real caller qualification.

Artifact final qualification:169context-output tests,11native dependency tests and both affected typechecks pass. Host initial broad qualification:518/520tests, with the preserved raw-fork RED and a SQLite parameter3 failure independently reproduced on actual cleanaf4BASE. Host correction:63bootstrap/intent tests,1genuine broker positive and2affected typechecks pass; unchanged broker30/Gateway-type evidence is explicitly reused. Counts overlap and are not summed. Expected diagnostic noise remains recorded.

Root independently checked all4178artifact physical inventory hashes and13net changed Git blobs, plus2750host hashes/recorded Git blobs and12net changed files, and the final command/log bindings; zero mismatches. The artifact physical inventory includes generated release-output files; it must not be described as a pure production-source inventory. These extra hashed files do not validate them as production consumers. Physical SHA256 and Git-normalized object identity remain separate.

The audit correction has meaningful82/84RED →84/84GREEN controls and excludes the declared desktop out/release/release-* directories while preserving genuine source with similar names. It changes no export, baseline or allowlist. The normal gate was run in MAIN after integration against its actual old package and now reports the same8NEWrows as cleanBASE, including llm-seam#withPreparedRequests. Gate remains exit1. This corrects the earlier environment-dependent7-row observation; it does not waive the eight findings.

Current detailed reports, same-reviewer corrections, full diff packages, raw execution records and independent audits are retained under `.superpowers/sdd/2026-10-23-context-transfer-host/` and the task-owned evidence directories named in those reports. A portable final archive is part of the connected Task3 handoff; this interim checkpoint does not claim those local files are already in Git.

The new [OpenCode reference study](2026-10-23-opencode-2.1.4-reference-analysis.md) and [causal comparison](2026-10-23-opencode-long-session-causal-comparison.md) prioritize observed long-session continuation failures. Stricter design or a safe refusal does not establish reliability. Current priorities are actual transfer/caller wiring, the reproduced Chat terminal-error gap, and comparable repeated-compaction/long-session host controls. The native-evidence continuation remains an unpromoted draft until its scope is reviewed against those needs. The original fourHTTP400requests remain unclassified; the later documented last-success input was760610tokens, not unknown.
