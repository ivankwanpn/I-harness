# Task transition fixture provenance

The format 13 empty, existing-empty, complete public bootstrap and incomplete public bootstrap files were written by the production owners at commit `5cb58e62766b4d1e821ac97b382a1dedb940a667`, Node 24.15.0. The incomplete birth was captured by terminating the original process before the first bootstrap frame write; no header or stage was edited. Files are copied byte-for-byte from that writer.

- `original13-empty.jsonl`: SHA-256 `3884a2e2b79c273c0971a5129eec74c7cba2c2a7ba1e2c6955c4887c65f04269`
- `empty13-target/target.jsonl`: `ed17dbf58db39a78f0f92bc970ce7dfb5f4a8e4987b487418d459589643d22ab`
- `bootstrap13-public/target.jsonl`: `330230e1edf02e0143cd0c37f7b6f4704f4a2868bf54f50429dd271cace31d98`
- `incomplete13-public/target.jsonl`: `b1858e87b4f5318efda505d16c8437773f98137cbb6af10817a60d5d0dae3f4e`
- Both public stage files: `f4e5c7203e7294b43341ef3ad2b5e390b729cd3fa9013e483327ccc3355e1218`

`synthetic12-child` is a deliberately constructed compatibility sample used to preserve an older unit test. It is **not** a genuine format 12 predecessor and is not evidence of an old writer. Its parent SHA-256 is `7f7f966acefc0386fab236959f70e4ee03177df889c07b1622159b25ccf1ec0e`; its stage is `871aa7796d9476402ba853aa0927ce24b738a45d8e1a9d26f9325692028fd6e6`.
