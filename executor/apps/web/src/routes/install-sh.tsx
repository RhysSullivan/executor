import { createFileRoute } from "@tanstack/react-router";
import { redirectResponse } from "@/lib/http/response";

export const Route = createFileRoute("/install-sh")({
  server: {
    handlers: {
      GET: () => redirectResponse("/install", 302),
    },
  },
});
