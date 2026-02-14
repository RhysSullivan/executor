"use client";

import { useEffect, useMemo, useState } from "react";
import { Layers, Globe, Server } from "lucide-react";
import type { ToolSourceRecord } from "@/lib/types";
import {
  getSourceFaviconCandidates,
  getSourceFaviconCandidatesForSource,
  getSourceFaviconProxyUrl,
} from "@/lib/tools/source-helpers";

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
  const sourceFaviconCandidates = useMemo(() => {
    if (sourceUrl) {
      return getSourceFaviconCandidates(sourceUrl);
    }

    return source
      ? getSourceFaviconCandidatesForSource(source)
      : [];
  }, [
    source?.id,
    source?.type,
    source?.name,
    sourceUrl,
    source?.config?.url,
    source?.config?.endpoint,
    source?.config?.baseUrl,
    source?.config?.collectionUrl,
    source?.config?.specUrl,
    source?.config?.spec,
  ]);

  const sourceFaviconCandidateKey = sourceFaviconCandidates.join("|");
  const [faviconIndex, setFaviconIndex] = useState(0);

  useEffect(() => {
    setFaviconIndex(0);
  }, [sourceFaviconCandidateKey]);

  const sourceFavicon = sourceFaviconCandidates[faviconIndex] ?? null;
  const sourceFaviconSrc = sourceFavicon ? getSourceFaviconProxyUrl(sourceFavicon) : null;
  const hasExhaustedCandidates = faviconIndex >= sourceFaviconCandidates.length;

  if (!sourceFaviconSrc || hasExhaustedCandidates) {
    const sourceType = fallbackType ?? source?.type ?? "openapi";
    return <DefaultSourceIcon type={sourceType} className={iconClassName} />;
  }

  const handleFaviconError = () => {
    setFaviconIndex((current) => {
      return current + 1;
    });
  };

  return (
    <img
      src={sourceFaviconSrc}
      alt=""
      width={imageSize}
      height={imageSize}
      className={imageClassName ?? "w-full h-full object-contain"}
      loading="lazy"
      onError={handleFaviconError}
    />
  );
}
