# @executor-js/cli

Minimal command-line entrypoint for Executor projects.

Schema generation and migrations are owned by FumaDB now. Hosts should build a
FumaDB client from `collectTables(plugins)` and use FumaDB's adapter/migrator
APIs directly instead of generating Executor-specific storage adapters.
