# Introduction

> This document is human written, meant to communicate how the project works and what its goals are

The vision of Executor is to be an open source layer for your integrations.

It is not AI specific

It is not code mode specific

It is a category of source and a way to interop between them.

Executor exposes 4 core concepts:

1. Tool

This is represented via an id, optionally an input schema, and optionally an output schema.

Input and Output schemas are JSON schemas, this may evolve in the future to support more complex data types

Input and Output schemas are

3. Source

A source contains tools

4. Secret

Tools and secrets

5. Manager

6. Plugin

A plugin can register tools, sources, adapters

7. Invokers, Managers,

## Features to ship

- Dynamic plugin support
  Run plugins in a v8 isolate, let your agent write whatever it needs, ship instructions as part of executor
- Integrations registry
- Configure executor via executor
- MCP apps with dynamic UI
  Use react flight / RSCs + code mode, enables
- Scope merging
- Workflows
  Ideally built ontop of "use workflow"
- SDK
- Internal apps catalog
- Store custom UI snippets
- MCP channels support like how Claude Code over Discord works to enable talking back to the agent mid tool call
- Storage
  Every chat gets a temporary KV, SQLite, Filesystem the agent can use to interact with. The agent can also create these on scopes to persist data between tool calls
- Scope merging
  I should be able to add tools at a global, workspace, account level, override the secrets on them per one, override policies, create temporary scopes etc
- Configure executor via executor

The focus of Executor should be to ship the primitives that build an extendable product. Everything needs to be written with that in mind
