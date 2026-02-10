import migrations from "@convex-dev/migrations/convex.config.js";
import stripe from "@convex-dev/stripe/convex.config.js";
import workOSAuthKit from "@convex-dev/workos-authkit/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();

const workosEnabled = Boolean(
  process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY && process.env.WORKOS_WEBHOOK_SECRET,
);

if (workosEnabled) {
  app.use(workOSAuthKit);
}
app.use(stripe);
app.use(migrations);

export default app;
