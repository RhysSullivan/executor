# openapi-extractor-rs

Rust implementation of the OpenAPI extraction pipeline used by `packages/management-api/src/openapi-extraction.ts`.

## Build

```bash
cargo build --release
```

## Build WASM Bindings For Runtime

This is the production path used by `@executor-v2/management-api`.

```bash
./build-wasm.sh
```

The script compiles `wasm32-unknown-unknown` and writes bindings/artifacts to:

- `packages/management-api/src/openapi-extractor-wasm/openapi_extractor.js`
- `packages/management-api/src/openapi-extractor-wasm/openapi_extractor_bg.wasm`

## Run

```bash
./target/release/openapi-extractor-rs \
  --source-name "Cloudflare API" \
  --input /tmp/cloudflare-openapi.yaml \
  --output /tmp/manifest-rs.json
```

Use `--input -` to read the OpenAPI document from stdin. Use `--pretty` for formatted JSON output.
