import type { Source } from "@executor/react";

import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { IconSpinner, IconTool } from "./icons";

export function SourceRecoveryState(props: {
  source: Source;
  title: string;
  description: string;
  refreshLabel?: string;
  refreshTitle?: string;
  refreshDisabled?: boolean;
  refreshPending?: boolean;
  feedback?: {
    tone: "success" | "error";
    text: string;
  } | null;
  onRefresh: () => void;
}) {
  return (
    <div className="flex h-full min-h-48 items-center justify-center px-6">
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <IconTool className="size-5" />
        </div>
        <h2 className="text-sm font-semibold text-foreground">{props.title}</h2>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{props.source.name}</span>
          <Badge variant="outline">{props.source.kind}</Badge>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{props.description}</p>
        {props.feedback && (
          <p
            className={cn(
              "mt-4 text-sm font-medium",
              props.feedback.tone === "success" ? "text-primary" : "text-destructive",
            )}
          >
            {props.feedback.text}
          </p>
        )}
        <div className="mt-5 flex items-center gap-2">
          <Button
            size="sm"
            onClick={props.onRefresh}
            disabled={props.refreshDisabled}
            title={props.refreshTitle}
          >
            {props.refreshPending ? <IconSpinner className="size-3" /> : null}
            {props.refreshLabel ?? "Refresh source"}
          </Button>
        </div>
      </div>
    </div>
  );
}
