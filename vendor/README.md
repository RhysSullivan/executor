# vendor/ — fork submodules (optional)

These are git submodules holding our forks of upstream projects. **Nothing in
the repo imports from `vendor/` at runtime** — code consumes the published
packages from npm — so a fresh clone works without initializing submodules.
They exist so the forks can be developed alongside the code that uses them.

| Submodule | Published as | Used by |
| --- | --- | --- |
| `vendor/mcporter` | `@executor-js/mcporter` | `e2e/` (headless MCP client with `cookieConsentStrategy`) |
| `vendor/emulate` | `@executor-js/emulate` | `e2e/` (wire-level WorkOS/Autumn emulators the real SDKs are pointed at) |

## Developing a fork

```bash
git submodule update --init vendor/mcporter
cd vendor/mcporter
pnpm install && pnpm build
```

To test local fork changes against the repo before publishing, point the
consumer at the submodule build with a temporary `file:` override (or
`bun link`), then revert once the new version is published:

```jsonc
// e2e/package.json (temporary, do not commit)
"@executor-js/mcporter": "file:../vendor/mcporter"
```

## Releasing a fork

Bump the fork's `package.json` version, publish from the submodule
(`npm publish --access public`), push the fork branch, bump the consumer's
dependency here, and commit the new submodule pointer.
