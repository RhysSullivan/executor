import { useState } from "react";
import type { Source } from "@executor/react";
import { getGoogleDiscoveryIconUrlForService } from "@executor/plugin-google-discovery-react";
import { getSourceFrontendIconUrl } from "../plugins";
import type { SourcePreset } from "../plugins/source-presets";
import { getSourceFaviconUrl } from "../lib/source-favicon";
import { cn } from "../lib/utils";

type SourceKind = Source["kind"] | SourcePreset["kind"] | string;

export function SourceFavicon({
  source,
  className,
  size = 16,
}: {
  source: Source;
  className?: string;
  size?: number;
}) {
  return (
    <ResolvedSourceIcon
      kind={source.kind}
      faviconUrl={getSourceFrontendIconUrl(source)}
      className={className}
      size={size}
    />
  );
}

export function SourcePresetFavicon({
  preset,
  className,
  size = 16,
}: {
  preset: SourcePreset;
  className?: string;
  size?: number;
}) {
  const faviconUrl = preset.kind === "google_discovery"
    ? getGoogleDiscoveryIconUrlForService(preset.service)
    : getSourceFaviconUrl(preset.previewUrl);

  return (
    <ResolvedSourceIcon
      kind={preset.kind}
      faviconUrl={faviconUrl ?? getSourceFaviconUrl(preset.name)}
      className={className}
      size={size}
    />
  );
}

function ResolvedSourceIcon({
  kind,
  faviconUrl,
  className,
  size = 16,
}: {
  kind: SourceKind;
  faviconUrl: string | null;
  className?: string;
  size?: number;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const isFailed = Boolean(faviconUrl && failedUrl === faviconUrl);

  if (!faviconUrl || isFailed) {
    return <DefaultSourceIcon kind={kind} className={className} />;
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
    case "google_discovery":
      return (
        <svg viewBox="0 0 16 16" fill="none" className={base}>
          <path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.3 5.3 0 0 0 3.82-1.55" stroke="currentColor" strokeWidth="1.2" />
          <path d="M13 8H8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
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
