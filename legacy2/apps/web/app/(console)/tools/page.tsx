import { ToolsView } from "../../../components/tools/tools-view";
import { configuredExternalOriginFromEnv } from "../../../lib/external-origin";

const resolveMcpBaseUrl = (): string | null => {
  return configuredExternalOriginFromEnv();
};

const ToolsPage = () => <ToolsView mcpBaseUrl={resolveMcpBaseUrl()} />;

export default ToolsPage;
