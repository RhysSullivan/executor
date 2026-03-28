import {
  defineExecutorFrontendPlugin,
} from "@executor/react/plugins";

import {
  ExecutionHistoryDetailPage,
  ExecutionHistoryPage,
} from "./components";

export const ExecutionHistoryReactPlugin = defineExecutorFrontendPlugin({
  key: "execution-history",
  displayName: "Execution History",
  description: "Browse previous executions for this workspace.",
  routes: [
    {
      key: "history",
      component: ExecutionHistoryPage,
      nav: {
        label: "Runs",
        section: "main",
      },
    },
    {
      key: "detail",
      path: "$executionId",
      component: ExecutionHistoryDetailPage,
    },
  ],
});
