import { createFileRoute } from "@tanstack/react-router";
import { redirectResponse } from "@/lib/http/response";

const DEFAULT_INSTALL_SCRIPT_URL =
  "https://raw.githubusercontent.com/RhysSullivan/executor/main/executor/install";

function handleInstall(): Response {
  const target = process.env.EXECUTOR_INSTALL_SCRIPT_URL ?? DEFAULT_INSTALL_SCRIPT_URL;
  return redirectResponse(target, 302);
}

export const Route = createFileRoute("/install")({
  server: {
    handlers: {
      GET: () => handleInstall(),
    },
  },
});
