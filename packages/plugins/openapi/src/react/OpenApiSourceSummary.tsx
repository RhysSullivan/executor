import { Result, useAtomValue } from "@effect-atom/atom-react";

import { Badge } from "@executor/react/components/badge";

import { openApiSourceAtom } from "./atoms";
import { useScope } from "@executor/react/api/scope-context";

function ConnectedBadge() {
  return (
    <Badge
      variant="outline"
      className="border-green-500/30 bg-green-500/5 text-[10px] text-green-700 dark:text-green-400"
    >
      Connected
    </Badge>
  );
}

// The entry row already renders name + id + kind, so this summary
// component only contributes extras — specifically, an OAuth status
// badge when the source has OAuth2 configured. Non-OAuth sources
// render nothing.
export default function OpenApiSourceSummary(props: { sourceId: string }) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(openApiSourceAtom(scopeId, props.sourceId));

  const oauth2 =
    Result.isSuccess(sourceResult) && sourceResult.value
      ? sourceResult.value.config.oauth2
      : undefined;

  if (!oauth2) return null;
  return <ConnectedBadge />;
}
