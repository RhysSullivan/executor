import { ToolsView } from "../../../components/tools/tools-view";

const resolveMcpBaseUrl = (): string | null => {
  const candidates = [
    process.env.CONTROL_PLANE_UPSTREAM_URL,
    process.env.CONTROL_PLANE_SERVER_BASE_URL,
    process.env.NEXT_PUBLIC_CONTROL_PLANE_BASE_URL,
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) {
      continue;
    }

    try {
      return new URL(value).origin;
    } catch {
      // ignore invalid URL and continue
    }
  }

  return null;
};

const ToolsPage = () => <ToolsView mcpBaseUrl={resolveMcpBaseUrl()} />;

export default ToolsPage;
