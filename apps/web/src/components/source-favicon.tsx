import { useMemo, useState } from "react";
import type { Source } from "@executor/react";
import { getGoogleProductIconUrl, getSourceFaviconUrl } from "../lib/source-favicon";
import { cn } from "../lib/utils";

type SourceKind = Source["kind"] | string;

export function SourceFavicon({
  endpoint,
  kind: _kind,
  className,
  size = 16,
}: {
  endpoint?: string | null;
  kind: SourceKind;
  className?: string;
  size?: number;
}) {
  const faviconUrl = useMemo(() => {
    return getGoogleProductIconUrl(endpoint) ?? getSourceFaviconUrl(endpoint);
  }, [endpoint]);

  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const isFailed = Boolean(faviconUrl && failedUrl === faviconUrl);

  if (!faviconUrl || isFailed) {
    return <DefaultSourceIcon kind={_kind} className={className} />;
  }

  return (
    <img
      key={faviconUrl}
      src={faviconUrl}
      alt=""
      width={size}
      height={size}
      className={cn("size-full object-contain", className)}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(faviconUrl)}
    />
  );
}

export function DefaultSourceIcon({
  kind,
  className,
}: {
  kind: SourceKind;
  className?: string;
}) {
  const base = cn("shrink-0", className);

  switch (kind) {
    case "internal":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <path d="M8 2v12M4 6l4-4 4 4M4 10l4 4 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 6h6M5 8h4M5 10h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
  }
}
