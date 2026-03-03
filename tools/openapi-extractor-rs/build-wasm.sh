#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CRATE_DIR="$ROOT_DIR/tools/openapi-extractor-rs"
OUT_DIR="$ROOT_DIR/packages/management-api/src/openapi-extractor-wasm"

cd "$CRATE_DIR"

rustup target add wasm32-unknown-unknown >/dev/null

cargo build --release --target wasm32-unknown-unknown

wasm-bindgen \
  --target web \
  --out-dir "$OUT_DIR" \
  --out-name openapi_extractor \
  "$CRATE_DIR/target/wasm32-unknown-unknown/release/openapi_extractor_rs.wasm"

rm -rf "$CRATE_DIR/target"
