# Root verifier metadata correction

The first root hash/physical-evidence audit found zero source, seal, frame, counter or recovery mismatches, but its generic IPC assertion incorrectly expected one message in positive setup cases. Both no-cut helpers intentionally send `setup`, close their genuine service/coordinator normally, then send `closed` and disconnect. The parent test explicitly waits for both messages and normal process close. Hard-crash cases send only `cut`.

The first `root-verification.json` remains unchanged with those two verifier failures. Root corrected only its independent checker to require exact message kinds `["setup","closed"]` for setup and `["cut"]` for crash, validating every message has the same nonce/id/mode/cut. The corrected audit writes a new `root-verification-v2.json`. No product, test, source fixture, writer receipt or seal was changed, and no tests were rerun to correct this metadata assumption.
