# Reviewed v22.18.0 native source argument

Representation: portable reviewed argument and provenance, not copied native implementation bytes. The runtime binary must match the original official win-x64/node.exe checksum text bundled beside this file. That pins the exact release whose sources were reviewed.

The complete scope/statement/temp/undo argument is [reviewed-policy.md](./reviewed-policy.md), [main journal](./delete-main-journal-source-argument.md), and [subjournal](./delete-subjournal-source-argument.md). Each is independently hash-bound in manifest.json.

Original official release sources and original raw SHA256:

- [src/node_sqlite.cc](https://github.com/nodejs/node/raw/refs/tags/v22.18.0/src/node_sqlite.cc): f3f9b8f8b4428c09ec61d250989fd92c34f8c916fdf83f4019b2df49a32c260e (92947 bytes)
- [src/node_sqlite.h](https://github.com/nodejs/node/raw/refs/tags/v22.18.0/src/node_sqlite.h): f198fd1a3e86b32686e1bb0cbf64db233aefb25550f145840b88384bfee283bf (9405 bytes)
- [deps/sqlite/sqlite.gyp](https://github.com/nodejs/node/raw/refs/tags/v22.18.0/deps/sqlite/sqlite.gyp): 822f3ea1667f29d020fea176100ba5be14689d7242562ae4f4bd1f2be2590f6a (932 bytes)
- [deps/sqlite/sqlite3.c](https://github.com/nodejs/node/raw/refs/tags/v22.18.0/deps/sqlite/sqlite3.c): c9a0b6829b81d5f1b78392181f09744c818117a725667411d517b98149fcd3be (9281384 bytes)

The qualified internal compiler scope is supported by the reviewed source branches and actual captured schema/plans; the ordinary compiler clones are not an internal SQL trace. Raw implementation sources are available at those exact official URLs; this explicit command never downloads them.
