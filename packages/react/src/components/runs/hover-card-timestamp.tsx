"use client";

import * as React from "react";
import { UTCDate } from "@date-fns/utc";
import { format, formatDistanceToNowStrict } from "date-fns";
import { Check, Copy } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../../lib/utils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../hover-card";

type HoverCardContentProps = ComponentPropsWithoutRef<typeof HoverCardContent>;

export interface HoverCardTimestampProps {
  readonly date: Date;
  readonly side?: HoverCardContentProps["side"];
  readonly sideOffset?: HoverCardContentProps["sideOffset"];
  readonly align?: HoverCardContentProps["align"];
  readonly alignOffset?: HoverCardContentProps["alignOffset"];
  readonly className?: string;
}

export function HoverCardTimestamp({
  date,
  side = "right",
  align = "start",
  alignOffset = -4,
  sideOffset,
  className,
}: HoverCardTimestampProps) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <HoverCard openDelay={0} closeDelay={0}>
      <HoverCardTrigger asChild>
        <div className={cn("font-mono whitespace-nowrap", className)}>
          {format(date, "LLL dd, y HH:mm:ss")}
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        className="z-50 w-auto p-2"
        side={side}
        align={align}
        alignOffset={alignOffset}
        sideOffset={sideOffset}
      >
        <dl className="flex flex-col gap-1">
          <CopyRow value={String(date.getTime())} label="Timestamp" />
          <CopyRow value={format(new UTCDate(date), "LLL dd, y HH:mm:ss")} label="UTC" />
          <CopyRow value={format(date, "LLL dd, y HH:mm:ss")} label={timezone} />
          <CopyRow value={formatDistanceToNowStrict(date, { addSuffix: true })} label="Relative" />
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}

function CopyRow({ value, label }: { readonly value: string; readonly label: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      });
    },
    [value],
  );

  return (
    <div
      className="group flex items-center justify-between gap-4 text-sm"
      onClick={handleCopy}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }
      }}
    >
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-1 truncate font-mono">
        <span className="invisible group-hover:visible">
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </span>
        {value}
      </dd>
    </div>
  );
}
