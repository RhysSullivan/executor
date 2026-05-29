import { SourceAccountBadge } from "./source-account-badge";
import { SourceFavicon } from "./source-favicon";

export function SourceIconWithAccount(props: {
  readonly icon?: string | null;
  readonly sourceId: string;
  readonly url?: string;
  readonly connection?: {
    readonly id: string;
    readonly scopeId: string;
    readonly identityLabel: string | null;
  } | null;
  readonly size?: "sm" | "md";
}) {
  const iconSize = props.size === "sm" ? 16 : 32;
  return (
    <span className={props.size === "sm" ? "relative size-4 shrink-0" : "relative size-8 shrink-0"}>
      <SourceFavicon icon={props.icon} sourceId={props.sourceId} url={props.url} size={iconSize} />
      {props.connection ? (
        <SourceAccountBadge
          connection={props.connection}
          size={props.size === "sm" ? "sm" : "md"}
        />
      ) : null}
    </span>
  );
}
