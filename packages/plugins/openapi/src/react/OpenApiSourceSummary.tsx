import { Result, useAtomValue } from "@effect-atom/atom-react";

import { SecretId, type ScopeId } from "@executor/sdk";
import { useScope } from "@executor/react/api/scope-context";
import { secretStatusAtom } from "@executor/react/api/atoms";
import { Badge } from "@executor/react/components/badge";
import { Skeleton } from "@executor/react/components/skeleton";

import { openApiSourceAtom } from "./atoms";

function ConnectedBadge(props: { accessTokenSecretId: string }) {
  const scopeId = useScope();
  const status = useAtomValue(
    secretStatusAtom(scopeId, SecretId.make(props.accessTokenSecretId)),
  );

  return Result.match(status, {
    onInitial: () => <Skeleton className="h-5 w-20 rounded-full" />,
    onFailure: () => (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        Not connected
      </Badge>
    ),
    onSuccess: ({ value }) =>
      value.status === "resolved" ? (
        <Badge
          variant="outline"
          className="border-green-500/30 bg-green-500/5 text-[10px] text-green-700 dark:text-green-400"
        >
          Connected
        </Badge>
      ) : (
        <Badge variant="outline" className="text-[10px] text-muted-foreground">
          Not connected
        </Badge>
      ),
  });
}

// The entry row already renders name + id + kind, so this summary
// component only contributes extras — specifically, an OAuth status
// badge when the source has OAuth2 configured. Non-OAuth sources
// render nothing.
export default function OpenApiSourceSummary(props: {
  sourceId: string;
  sourceScopeId?: ScopeId;
}) {
  const currentScopeId = useScope();
  const sourceScopeId = props.sourceScopeId ?? currentScopeId;
  const sourceResult = useAtomValue(openApiSourceAtom(sourceScopeId, props.sourceId));

  const oauth2 =
    Result.isSuccess(sourceResult) && sourceResult.value
      ? sourceResult.value.config.oauth2
      : undefined;

  if (!oauth2) return null;
  return <ConnectedBadge accessTokenSecretId={oauth2.accessTokenSecretId} />;
}
