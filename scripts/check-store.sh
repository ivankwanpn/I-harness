#!/usr/bin/env bash
# pnpm store 完整性檢查（M26 撞見兩次 SDK store 損壞；CI/本地門 —— `pnpm verify:store`）。
# `pnpm store status` 報 altered 檔案 → exit 1；clean 時輸出固定成功變體：
#   - pnpm >= 9: "Packages in the store are untouched"
#   - pnpm < 9:  "No altered files found"
set -euo pipefail

out=$(pnpm store status 2>&1 || true)

if ! echo "$out" | grep -qE "No altered files found|Packages in the store are untouched"; then
  echo "pnpm store integrity issues detected. Run: pnpm store prune"
  echo "$out"
  exit 1
fi
echo "pnpm store: clean"
