# Portable bounded-integrity review evidence

See [root acceptance](../2026-10-21-context-r4a-result-integrity-acceptance.md) for scope, original identities and limits.

`original-bytes.json` contains67 exact copied artifacts, each with original relative path, byte count, SHA256 and base64. Decode an entry to recover the original bytes independent of checkout newline policy. Readable companion files are convenient views; use the encoded originals when validating original hashes.

`receipts/*.output.json` preserve native console bytes, including the failed/setup/RED/discovery outputs and their original trailing newlines. They replace only newly created portable `.output.txt` copies to avoid transforming original output for source whitespace checks. No sealed source log was edited.

The regular receipt JSON files record actual native exits, command arguments, isolated environments and times. Test results require their paired decoded console output and scope; a receipt alone is not a functional oracle. Root's identity and behavior audit results are separate from the fresh reviewer report.

The evidence seal binds the full local3081entry inventory; complete artifact bodies/link fixtures remain in `.tmp/r4ai-1021-01/`. The portable subset does not claim to include every raw retained body. Root audit scripts are historical read-only audit sources bound to the original review HEAD, not portable product test runners or permission to write old sealed evidence.
