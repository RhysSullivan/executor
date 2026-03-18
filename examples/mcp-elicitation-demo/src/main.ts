import { startMcpElicitationDemoServer } from "./server";

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ? Number(process.env.PORT) : 58506;

const server = await startMcpElicitationDemoServer({ host, port });
console.error(`mcp-elicitation-demo listening on ${server.endpoint}`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", () => {
  void shutdown();
});

process.once("SIGTERM", () => {
  void shutdown();
});
