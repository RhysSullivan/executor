"use client";

import { useMemo, useState } from "react";
import { getSourceFaviconUrl } from "../../lib/tools/source-helpers";
import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// SourceFavicon — tries Google favicon, falls back to kind-based SVG icon
// ---------------------------------------------------------------------------

export function SourceFavicon({
  endpoint,
  kind,
  className,
  size = 16,
}: {
  endpoint?: string | null;
  kind: string;
  className?: string;
  size?: number;
}) {
  const faviconUrl = useMemo(() => getSourceFaviconUrl(endpoint), [endpoint]);
  const [failed, setFailed] = useState<string | null>(null);
  const isFailed = Boolean(faviconUrl && failed === faviconUrl);

  if (!faviconUrl || isFailed) {
    return <DefaultSourceIcon kind={kind} className={className} />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={faviconUrl}
      src={faviconUrl}
      alt=""
      width={size}
      height={size}
      className={cn("size-full rounded-full object-cover", className)}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(faviconUrl)}
    />
  );
}

// ---------------------------------------------------------------------------
// DefaultSourceIcon — fallback SVG icon based on source kind
// ---------------------------------------------------------------------------

export function DefaultSourceIcon({ kind, className }: { kind: string; className?: string }) {
  const base = cn("shrink-0", className);
  switch (kind) {
    case "mcp":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 7h1M5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "graphql":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <path d="M8 2L14 5.5V10.5L8 14L2 10.5V5.5L8 2Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" opacity="0.5" />
        </svg>
      );
    case "openapi":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 6h6M5 8h4M5 10h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
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
