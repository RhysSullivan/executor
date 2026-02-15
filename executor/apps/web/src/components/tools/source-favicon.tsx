"use client";

import { useState } from "react";
import { Layers, Globe, Server } from "lucide-react";
import Image from "next/image";
import type { ToolSourceRecord } from "@/lib/types";
import { getSourceFavicon, getSourceFaviconUrl } from "@/lib/tools/source-helpers";

interface SourceFaviconProps {
  source?: ToolSourceRecord;
  sourceUrl?: string;
  iconClassName?: string;
  imageClassName?: string;
  imageSize?: number;
  fallbackType?: ToolSourceRecord["type"] | "local";
}

function DefaultSourceIcon({ type, className }: { type: ToolSourceRecord["type"] | "local"; className?: string }) {
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
    <Image
      key={sourceFavicon}
      src={sourceFavicon}
      alt=""
      width={imageSize}
      height={imageSize}
      className={imageClassName ?? "w-full h-full object-contain"}
      loading="lazy"
      unoptimized
      onError={() => setFailedSrc(sourceFavicon)}
    />
  );
}
