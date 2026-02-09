import { ToolsView } from "@/components/tools-view";

export default async function ToolsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const source = typeof params.source === "string" ? params.source : null;

  return <ToolsView initialSource={source} />;
}
