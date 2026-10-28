# Observation pins and live session adoption

2026-10-29 HKT. MAIN `5841cac744de2dc6e8b5dba06d0a3f07c89471bc` is accepted as the O1 live-adoption distinction prerequisite. It is also a reproduced correction to existing project-move and archive recovery behavior.

`ownerOf` correctly reports a held native lock, including a temporary read pin. The two Gateway callers incorrectly treated that as a previously adopted live writer. If a cold session was being observed, their subsequent adoption was retained after the operation instead of released. The new passive `hasLiveOwnership` reads the original slot's live/held/nondebt/nonreleasing state; the coordinator forwards it, and both callers capture that value before their own adoption. Physical `ownerOf` semantics and original acquisition, cleanup, callbacks and queues remain intact. Legacy custom coordinators retain the old fallback; future retained-observation support must require the new getter.

Root's controls use real native pins, the actual existing observation callback and actual move/archive operations. A wrapper pauses the original adoption method after real acquisition; it does not fabricate ownership. The two cold caller cases failed before the change and passed afterward, while already-live cases remained held. Root also verified that another real coordinator can acquire after the corrected cold operation.

Verification: persistence59 tests passed; new Gateway controls4 passed; selected Gateway compatibility48 passed and2 failed. Both affected type checks exited0. The two unchanged fork assertions were independently reproduced on immutable BASE `023b453c` in the idle CURRENT checkout:25 passed and the same2 failed. They concern expected seedLength7/actual3 and an old completed-turn refusal message. No expected value was weakened and no failure was waived. CURRENT was restored to its committed branch afterward.

Independent Sol review found no blocking source issue and bound the exact seven-file diff to the saved source. Mixed newline representations were resolved through explicitly named unchanged source paths and normalized Git blobs. Evidence, raw failures, command/root/source receipts and review are under `.superpowers/sdd/2026-10-29-execution-live-ownership/`.

This prerequisite does not implement the retained inspector, profile tickets, cleanup-operation tokens, event subscription or UI lifecycle. The full existing suite is not green merely because these callers are corrected. Version0.1.13-rc.1 / Session13 remains unchanged; no release was performed.
