"use client";

/* eslint-disable @next/next/no-img-element */

import { useState } from "react";
import { Layers, Globe, Server, Terminal } from "lucide-react";
import type { ToolSourceRecord } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getSourceFavicon, getSourceFaviconUrl } from "@/lib/tools/source-helpers";

interface SourceFaviconProps {
  source?: ToolSourceRecord;
  sourceUrl?: string;
  iconClassName?: string;
  imageClassName?: string;
  imageSize?: number;
  fallbackType?: ToolSourceRecord["type"] | "local" | "system";
}

export function DefaultSourceIcon({ type, className }: { type: ToolSourceRecord["type"] | "local" | "system"; className?: string }) {
  if (type === "system") {
    return <Terminal className={className} />;
  }
  if (type === "mcp") {
    return <Server className={className} />;
  }
  if (type === "graphql") {
    return <Layers className={className} />;
  }
  return <Globe className={className} />;
}

export function SourceFavicon({
  source,
  sourceUrl,
  iconClassName = "h-4 w-4 text-muted-foreground",
  imageClassName,
  imageSize = 20,
  fallbackType,
}: SourceFaviconProps) {
  const sourceFavicon = sourceUrl
    ? getSourceFaviconUrl(sourceUrl)
    : source
      ? getSourceFavicon(source)
      : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const isFailed = Boolean(sourceFavicon && failedSrc === sourceFavicon);

  if (!sourceFavicon || isFailed) {
    const sourceType = fallbackType ?? source?.type ?? "openapi";
    return <DefaultSourceIcon type={sourceType} className={iconClassName} />;
  }

  return (
    <img
      key={sourceFavicon}
      src={sourceFavicon}
      alt=""
      width={imageSize}
      height={imageSize}
      className={cn("w-full h-full object-cover rounded-full", imageClassName)}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(sourceFavicon)}
    />
  );
}
