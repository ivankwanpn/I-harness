# IH usage statistics

Approved in chat on 2026-10-11. Version remains 0.1.7.

Build a dedicated global Settings > Usage statistics page. Reference local CC Switch 4.0.8 dashboard hierarchy, ZCode activity and model distribution, and DSH per-request cache breakdown. Use IH theme variables, rounded panels, restrained colors and responsive layout. Original code, no copied vendor components.

Page: local-calendar today / 7 days / 30 days / custom dates; workspace/provider/model filters; requests, total tokens, token-weighted cache hit rate and estimated API cost; input/output/cache breakdown; stacked daily trend with metric switch; activity heatmap; model ranking; model/provider/request tables and request details. Missing measurements remain unavailable. Include loading, empty, stale/error and pagination states. Keyboard accessible details and tooltips; light/dark and narrow layouts.

Introduce @i-harness/usage-stats owning durable, idempotent request records, normalization, filtering and aggregation. Record model calls automatically, including failed/cancelled outcomes and optional reported usage. Never save prompts, responses, secrets or raw errors. Persist records outside conversation content so archiving/forking/rewinding a conversation cannot duplicate or remove billing history. Independent hosts must not overwrite each other. Existing history with no measured usage is not reconstructed from text.

Input semantics are adapter-declared includes-cache/excludes-cache; no double counting. Ratios aggregate only requests with matching measured numerator/denominator and expose coverage. Subscription calls count tokens but never imply API billing or remaining plan allowance. Pricing is optional explicit per-model USD-per-million with source and timestamp; unknown stays unpriced; estimates are labelled, not bills. Query global history without requiring an active workspace.

Tests: restart/concurrent records/duplicate IDs; inclusive-exclusive normalization/partial-invalid usage; weighted ratios and coverage; timezone/calendar boundaries; filtering/page limits; subscription versus API pricing; real gateway capture and IPC; UI filters/details/empty/error/theme/responsiveness. No live credentials or reset card operations.
