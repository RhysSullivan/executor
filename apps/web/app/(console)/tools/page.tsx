import { ToolsView } from "../../../components/tools/tools-view";

const normalizeOriginCandidate = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const withProtocol =
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://${trimmed}`;

  try {
    return new URL(withProtocol).origin;
  } catch {
    return null;
  }
};

const resolveMcpBaseUrl = (): string | null => {
  const candidates = [
    process.env.CONTROL_PLANE_UPSTREAM_URL,
    process.env.CONTROL_PLANE_SERVER_BASE_URL,
    process.env.NEXT_PUBLIC_CONTROL_PLANE_BASE_URL,
    process.env.EXECUTOR_PUBLIC_ORIGIN,
    process.env.NEXT_PUBLIC_APP_ORIGIN,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
  ];

  for (const candidate of candidates) {
    const origin = normalizeOriginCandidate(candidate);
    if (origin) {
      return origin;
    }
  }

  return null;
};

const ToolsPage = () => <ToolsView mcpBaseUrl={resolveMcpBaseUrl()} />;

export default ToolsPage;
