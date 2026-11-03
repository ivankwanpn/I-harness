# Team message ownership — Tasks1+2 bounded acceptance

2026-10-27. Approved plan: ../superpowers/plans/2026-10-27-team-acknowledgement-settlement.md. This acceptance covers original message admission/consumed acknowledgement and actual bridge normalization, not partial construction, whole service shutdown or the final race/inverse pair.

Donors78c98f312d181d412f9c16c978334b0b1b945135 and a42f8606d65523e14b7bdee22179076dfc18dae2 were integrated as fedc21c8 and8ea95aa4. Root verified all seven changed Git blobs match the reviewed candidate. Fixed MAIN8ea95aa417a48a908a9855f58f1ac2fd59a57f97 then passed51/51 focused tests and agent-team TypeScript checking using fresh six IH roots and existing direct Node/Vitest/TS.

The same original record owns optional queue admission, actual delivery disposition and required consumed acknowledgement. Serial-clone admission retains the real per-member capacity limit. Delivery runs outside the lane. Required ack capture is created only after known consumption and uses the mount's original source, avoiding a new action after shutdown. Unknown/absent/conflict/local-installation debt stays on the original capture; no callback or guest is replayed. A failed send can have its original queue reconciled without silently dispatching it; later explicit OPEN mailbox recovery is separate optional work.

The shipping bridge distinguishes no target call, target-owned uncertainty, actual consumption and trusted Stop at the original admit boundary. Parent wake's historically caught-false failure remains queued without a new rejection or acknowledgement. Previously escaping errors remain exact, including undefined/null. These states do not claim model acceptance.

Independent review found concurrent explicit drains could schedule duplicate installation of the same original ack. Controlled RED reproduced duplicate-delivered for undefined/null caller failures. The fix coalesces the original record's in-flight ack settlement and retains retryable original debt. Four overlap controls, including drain versus source close, passed; the same reviewer closed the finding. The typecheck report's missing empty-output artifact citation was corrected rather than fabricated.

Evidence remains in .superpowers/sdd/2026-10-27-team-acknowledgement-settlement: task-1 report/review/rereview; original RED/GREEN commands and receipts; actual capture keys/identities and journal bytes; root-integration/tests-receipt.json, types-receipt.json and source-audit.json. Test totals describe their scopes and are not added together.

Tasks3+4 now own retained partial Team/assembly construction, completion records, phased child/tool/role/source cleanup, error propagation and explicit same-owner close retry. Task5 still must prove the actual service committed-admission-return/Stop order pair. Code Mode historical cleanup and Stage6 remain separate open gates. No version change, push, tag or release occurred.
