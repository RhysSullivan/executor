import { configSchema, pub } from "better-env/config-schema";
import { trim } from "./shared";

const webPublicEnvConfig = configSchema("WebPublicEnvironment", {
  nextPublicAppOrigin: pub({
    env: "NEXT_PUBLIC_APP_ORIGIN",
    value: process.env.NEXT_PUBLIC_APP_ORIGIN,
    optional: true,
  }),
  nextPublicWorkosRedirectUri: pub({
    env: "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
    value: process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI,
    optional: true,
  }),
});

const env = webPublicEnvConfig.public;

export const webPublicEnvironment = {
  nextPublicAppOrigin: trim(env.nextPublicAppOrigin),
  nextPublicWorkosRedirectUri: trim(env.nextPublicWorkosRedirectUri),
};
