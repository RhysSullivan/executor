Executor:

Project goal: Build an execution environment for agents to interact with APIs, MCPs, GraphQL, and other services via writing TypeScript.

The way things work today is if people want to interact with services, they either add an mcp or they call it through a cli. for mcp servers when someone adds it to their agent, it blows up the context window of tokens. the agent isn't able to call it in an efficient way and it adds a lot of bloat so people have ended up using clis instead.

the problem with the cli is people run things in dangerously allowable permissions. along with that you don't have typing and information about what clis are installed, what they can do, et cetera. by creating this typescript code execution environment we're able to handle both those problems. you can read the article code mode to understand deeper the benefits of this approach.

the basic premise is that you give the agent the ability to search over what can be called from typescript and write code to call it. it can see the typings properly through typescript.

let's look at some examples.

let's say the agent wants to list the github issues for a repository. the agent call is executed through an mcp call and it parses typescript code from that. that typescript code will basically just be

`tools.discover` and then the query which is github issues list.

so `tools.discover("github issues list")`

that then returns the callable paths and then the agent writes another line of code. that is await tools.github.issues.list. that executes in a sandbox and it calls a proxy object which makes a fetch to run the call and then that runs that call in the secure environment. that call completes and the results are given to the sandbox and the sandbox resumes.

another instance is the case where a tool needs some form of user action. the example that i will give is approvals and if it's a create issue for example, the agent would write `await tools.github.issues.create`. that would then call the proxy object. the proxy object would trigger the interaction and then once the user approves that interaction it resumes.

a note on the interaction model: i believe we want to model this off of mcp elicitation which you can see the spec for in references. the reason we want to model it off of mcp elicitation is that for apis for example that will just be a standard approve/deny model but for something like this since we support calling mcp servers those mcp servers could actually try and elicit input for the user.

So let's talk about interaction model a little bit. Executor is going to be configurable through Executor, and so you would be able to add a source, for example, by just prompting: "Hey, please add Axiom as a source." What it would do is it would call tools.executor.AddSource, which calls the MCP server. That MCP server matches kind of the web flow where there's information or an action you need to elicit from the user. What that information action looks like is in the OAUTH flow. It's: they have to go sign in somewhere; there's some callback that happens, and then something's created for that. It's details on that, but we get them onto a web page in the browser to sign in. A similar thing would be if a source required an API key. It's the same concept if you open up a web page to securely input that.

Current state:

We are on v3 of this codebase which is a completely fresh start, the original codebase is in legacy/, the v2 is in legacy2/.

Architecture I like:

Database:
Postgres SQLIte for local, Postgres SQL for cloud hosted version

Server:

- API
  The web dashboard calls the API via effect-atom.

- MCP
  Executor is configurable via executor. A user can enter the prompt "Please add the https://mcp.notion.com/mcp to my workspace"

We use MCP here instead of the API as the user has to perform actions in many cases. An example of this is OAuthing to an MCP server or opening a page to set a secret in. This prevents the secrets from being pasted over a chat

Doing MCP here w/ MCP elicitation allows us to not give special treatment to the executor app while also giving a nice UX

Ideally the MCP server shares a lot of logic between API

Clients:

- Web client
  Cloud product hosted at executor.sh, local one just on localhost
  This is a next.js app, so we will actually host the api/ in a route handler on it however it's important we implement the API in a standalone package and it just exposes a standard web request / response handler
- CLI
  Connects to either the cloud api endpoint

Standalone:

- SDK
  Allows for people to use everything we've built in their own apps, including ingesting API specs / MCPs for calling

Runtimes:

- Deno
- In process
- Cloudflare worker runtime

Other:

- Avoid hardcoding strings in the core libraries, prefer programming to interfaces, this is because it allows people to build custom adapters without having to modify the core
- Aim for composability of adapters. For example, the cloud product may be able to leverage storing secrets both encrypted in postgres and also BYO 1password setup. This does not need to be implemented today but worth noting
- This is a fresh start so we can make whatever changes we need.

Rough architecture is: Turborepo monorepo, effect-vitest for testing, bun for package manager / running apps (but we leverage Effect wherever possible rather than bun's apis i.e for the server), Next.js for web app

References:
https://blog.cloudflare.com/code-mode/ - concept we are implementing
https://mcp.axiom.co/mcp - MCP server that requires auth
https://modelcontextprotocol.io/specification/draft/client/elicitation - How we are going to be handling interactions from the user
legacy/ original implementation
legacy2
