# Mixed native retention qualification

Root-owned narrow test packet under the integrated known-failure ledger. The actual native mixed-retention test stops at the archived-session branch: it expects `/unauthorized/`, while the existing actual source owner rejects with `Result source session archived`. The same failure is recorded on unchanged BASE in the result-store cleanup packet; the source policy is not changing.

Keep all real native storage, saved policy, quota, TTL, project revocation, index recovery, selective deletion and exact bytes/count assertions. Change only the archived-session rejection expectation to the specific original archive refusal and run the complete scenario so its later assertions become reachable. Preserve any subsequent failure; do not weaken those assertions or claim success before the whole control reaches its final record. No product code, format/version, dependency, privilege or release changes.

Run from session-executor with isolated IH_CONFIG_DIR and IH_MIXED_RETENTION_EVIDENCE_ROOT, maxWorkers=2/minWorkers=1; also run its related mixed quota controls to catch shared fixture issues. Bind source and raw results. Any newly reached product failure needs diagnosis and a separately ruled implementation scope. Obtain an independent review of the narrow full range before accepting the ledger closure. General decomposition stays deferred.
