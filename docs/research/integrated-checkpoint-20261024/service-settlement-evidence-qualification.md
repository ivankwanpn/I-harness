# S2 retained evidence qualification

Root independently matched all six final physical source files, their receipt28 source copies and HEAD Git blobs. Thirty execution directories retain actual receipt.json records with command, package CWD, start/end timestamps, numeric exit and source hashes.

Seven typecheck directories do not contain output.log:05,06,14,23,24,29,30. Their real receipt.json records exist; final29/30 record tsc --noEmit with exit0 and final source hashes. The implementation report's generic wording that every run has an output.log is therefore too broad. No missing text log was reconstructed and no command was rerun merely to recreate one. The success claim for these typechecks is supported by their actual structured execution receipts, not a nonexistent plaintext file. Failed typecheck runs with emitted diagnostics retain their actual output separately.

The first root audit attempted to hash those absent output files and produced file-not-found diagnostics; its JSON is preserved as root-source-evidence-audit-first.json. The corrected root-source-evidence-audit.json explicitly records outputPresent=false for these seven entries and retains the verified receipt hashes. Neither audit's successful source comparisons prove a nonexistent output hash.
