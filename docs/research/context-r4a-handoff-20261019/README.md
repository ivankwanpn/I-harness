# R4A handoff evidence index

These are byte-identical copies of the local handoff inventory, independent
root verification and final focused run receipts. They preserve the exact
handoff facts for the separate implementer without requiring the original chat.

- `product-paths.json`:188 changed/new product and test files with original
  working-file byte lengths and SHA256; pre-commit metadata records the original
  BASE, not the later WIP preservation commit.
- `root-verification.json`: independent live-byte and226/227 receipt/source
  verification at the frozen handoff source,2568 source inputs,0errors.
- `226-reader-receipt.json`: final30 Gateway reader controls.
- `227-gateway-types-receipt.json`: final Gateway TypeScript check.

The raw logs and full before/after source manifests remain in the original
local evidence directory named by the receipts. These copies are not the full
closed R4A acceptance bundle. Git line-ending normalization may differ from
the original Windows working bytes; preserve that distinction when verifying
a checkout on another machine.

Product WIP commit:`81917360215c17ca00e5a9df4c312bd8f9056f3e`.
Full R4A BASE:`91d8fef04253272a437c68f5f2f84a657fa53d3b`.
Status:**UNACCEPTED**. See the parent handoff checkpoint and execution plan.
