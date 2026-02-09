import actionCache from "@convex-dev/action-cache/convex.config.js";
import stripe from "@convex-dev/stripe/convex.config.js";
import workOSAuthKit from "@convex-dev/workos-authkit/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();

app.use(workOSAuthKit);
app.use(stripe);
app.use(actionCache);

export default app;
