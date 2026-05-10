import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { marketingStack } from "./infra/stack";

const appDir = new URL(".", import.meta.url).pathname;

export default Alchemy.Stack(
  "ExecutorMarketing",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  marketingStack(appDir),
);
