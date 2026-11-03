# Genuine format10 predecessor fixture

This capsule retains the exact 177-file, ten-package execution graph accepted at product `678af03dd54659e22dd5f941112c06ec9917e812`. The old source is unchanged; it is not a current validator configured to imitate format10. `manifest.json` records portable relative paths, exact byte sizes and SHA256 hashes, package names, product identity, compressed/decoded limits and accepted source inventory/map/seal hashes.

`graph.json.gz` is gzip-compressed JSON containing only relative path/base64 data entries. The original graph includes the chokidar and readdirp MIT LICENSE files. The original product root MIT license is retained as `LICENSE` and as one additional capsule entry (178 entries total; 177 original graph files).

The maintained test verifies and extracts into a new temporary root, then executes the actual old reader under the declared Node runtime and existing tsx dependency. No Bun, prior `.tmp` evidence, Git history or network is used by normal qualification. Missing/corrupt fixtures fail; there is no skip/fallback. The old graph imports resolve inside its extracted package root. Ready, header-only and interrupted format11 inputs must refuse before repair/upgrade/provider execution and preserve input bytes.

Optional regeneration from the preserved accepted evidence, for maintainers with those exact sealed inputs:

```sh
node scripts/test-fixtures/regenerate-format10-predecessor.mjs <accepted-evidence-root>
```

Regeneration checks the accepted inventory and source-copy-map hashes, each of the exact 177 graph files against both the map and sealed inventory, rejects links/unmapped files and retains original bytes. It obtains only the original first-party license from the pinned Git revision. This optional provenance operation is separate from normal tests. The historical accepted evidence is read only.
