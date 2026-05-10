import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { cloudStack } from "./infra/stack";

const appDir = new URL(".", import.meta.url).pathname;

export default Alchemy.Stack(
  "ExecutorCloud",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  cloudStack(appDir),
);
