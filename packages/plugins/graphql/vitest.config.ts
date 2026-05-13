import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        inline: ["graphql", "graphql-yoga", "@graphql-tools", "@envelop", "@whatwg-node"],
      },
    },
  },
});
