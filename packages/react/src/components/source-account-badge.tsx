import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { ConnectionId, ScopeId } from "@executor-js/sdk/shared";

import { connectionIdentityAtom } from "../api/atoms";

export function SourceAccountBadge(props: {
  readonly connection: {
    readonly id: string;
    readonly scopeId: string;
    readonly identityLabel: string | null;
  };
  readonly size?: "sm" | "md";
}) {
  const identityResult = useAtomValue(
    connectionIdentityAtom(
      ScopeId.make(props.connection.scopeId),
      ConnectionId.make(props.connection.id),
    ),
  );
  const identity =
    AsyncResult.isSuccess(identityResult) && identityResult.value.status === "available"
      ? identityResult.value
      : null;
  const label = identity?.email ?? identity?.name ?? props.connection.identityLabel ?? "Connected";
  const sizeClass = props.size === "sm" ? "size-3 text-[7px]" : "size-4 text-[9px]";
  const badgeClass = `absolute -bottom-1 -right-1 z-10 flex ${sizeClass} items-center justify-center rounded-full border-2 border-card bg-background font-medium leading-none text-muted-foreground shadow-sm`;

  return identity?.picture ? (
    <span
      title={label}
      className={`${badgeClass} bg-cover bg-center`}
      style={{ backgroundImage: `url("${identity.picture.replaceAll('"', "%22")}")` }}
    />
  ) : (
    <span title={label} className={badgeClass}>
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}
