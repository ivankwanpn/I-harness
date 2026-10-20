# Root verification setup correction

The first root read-only audit invocation exited1 before creating a result report because the verifier assumed a `copy-map-final-v2.json` filename. The actual preserved v2 map is `copy-map.json`; its candidate path and source digest explicitly identify final-v2/661955. The separate v3 map uses `copy-map-final-v3.json`. Root corrected only this verifier filename selection and reran the audit.

No product/test/evidence files were modified, no behavioral test was run, and this setup error is not a product failure or qualification result.

The second audit completed but its first JSON report recorded verifier interpretation failures: receipt `name` excludes `.json` while the seal's selected labels include it; fixture edit coordinates span the module literal **contents**, excluding quote characters; `removedSuffixBase64` describes the old complete EOF suffix after trimEnd, not bytes appended to the already normalized new newline. Root inspected literal source slices and reconstructed original hashes, corrected those three interpretations, and wrote a new `task-1-root-verification-v2.json` rather than overwriting the first report. The original report remains local as setup evidence. No product/evidence hash failure was established by those interpretation errors.
