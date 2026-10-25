# Reviewed v24.15.0 native source argument

Representation: portable reviewed argument and provenance, not copied native implementation bytes. The runtime binary must match the original official win-x64/node.exe checksum text bundled beside this file. That pins the exact release whose sources were reviewed.

The complete scope/statement/temp/undo argument is [reviewed-policy.md](./reviewed-policy.md), [main journal](./delete-main-journal-source-argument.md), and [subjournal](./delete-subjournal-source-argument.md). Each is independently hash-bound in manifest.json.

Original official release sources and original raw SHA256:

- [src/node_sqlite.cc](https://github.com/nodejs/node/raw/refs/tags/v24.15.0/src/node_sqlite.cc): ce249c17c02dbefc4fcab55cced04f3c6e114193c3c5924b0aec6fe56c961849 (127571 bytes)
- [src/node_sqlite.h](https://github.com/nodejs/node/raw/refs/tags/v24.15.0/src/node_sqlite.h): fdbab6d0ca552077c303c8b8e3bf9105c048e75e5e406f52779df35cca01e0fa (16444 bytes)
- [deps/sqlite/sqlite.gyp](https://github.com/nodejs/node/raw/refs/tags/v24.15.0/deps/sqlite/sqlite.gyp): 822f3ea1667f29d020fea176100ba5be14689d7242562ae4f4bd1f2be2590f6a (932 bytes)
- [deps/sqlite/sqlite3.c](https://github.com/nodejs/node/raw/refs/tags/v24.15.0/deps/sqlite/sqlite3.c): 9512509b1bccb7461f79bea8aad6280ae4699e925fa4804381b71f59e7efb0c5 (9390466 bytes)

The qualified internal compiler scope is supported by the reviewed source branches and actual captured schema/plans; the ordinary compiler clones are not an internal SQL trace. Raw implementation sources are available at those exact official URLs; this explicit command never downloads them.
