import { $ } from "bun";

let prompt = `
You're running in a while loop with new sesions each time, you will have to check to see what the progress so far that has been made is.

We are migrating from an old, very messy model to a plugin system for OpenAPI, GraphQL, MCP, and Google Discovery. You'll see that we've got the OpenAPI implemented. If you look at the Git diff on this branch, you'll see a bunch of deleted files and functionality around the rest of the product. We have to bring back all of the functionality that was removed for GraphQL and MCP of an API or Discovery. The thing is that it has to be now localised to those plugins, so you can read the plugin and the functionality will go away. Some examples of that are:

- how Google Discovery has the or credentials and that or flow; that all gets implemented in the Google Discovery plugin
- the MCP OAuth stuff gets implemented in the MCP plugin

Plugins can own storage; they can own API routes. They're meant to extend the product. If the product does not match what the plugins need, then we can extend the core, but the core should not be plugin-specific. What you need to do is work until this is fully migrated to this new model. Once it is fully migrated, output <STOP-TOKEN-124124> 3 times so you stop working.

Feel free to autonomously test the app yourself via calling the API or running the local CLI

You can take notes in agent-notes/
`
let output = ''

do {
  output = await $`codex exec --yolo "${prompt}"`.then(result => String(result.stdout));
} while (// stop token has to show up more than 1 time
  output.split("\n").filter(line => line.includes("<STOP-TOKEN-124124>")).length < 2);
