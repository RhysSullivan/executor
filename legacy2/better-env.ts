import { defineBetterEnv, vercelAdapter } from "better-env";

export default defineBetterEnv({
  adapter: vercelAdapter(),
  environments: {
    development: {
      envFile: ".env.development",
      remote: "development",
    },
    preview: {
      envFile: ".env.preview",
      remote: "preview",
    },
    production: {
      envFile: ".env.production",
      remote: "production",
    },
    test: {
      envFile: ".env.test",
      remote: null,
    },
    local: {
      envFile: ".env.local",
      remote: null,
    },
  },
});
