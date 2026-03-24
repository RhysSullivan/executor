import { useEffect, useState } from "react";
import { useSource } from "@executor/react";
import { LoadableBlock } from "../components/loadable";
import { SourcePluginsResetState } from "../components/source-plugins-reset-state";
import {
  getDefaultSourceFrontendType,
  getSourceFrontendType,
  registeredSourceFrontendTypes,
} from "./index";

export type SourcePluginRouteSearch = {
  tab: "model" | "discover";
  tool?: string;
  query?: string;
};

const SourcePluginPicker = (props: {
  selectedKind: string | null;
  onSelect: (kind: string) => void;
}) => {
  if (registeredSourceFrontendTypes.length <= 1) {
    return null;
  }

  return (
    <div className="mb-8 flex flex-wrap gap-2">
      {registeredSourceFrontendTypes.map((definition) => (
        <button
          key={definition.kind}
          type="button"
          onClick={() => props.onSelect(definition.kind)}
          className={
            props.selectedKind === definition.kind
              ? "rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-medium text-foreground"
              : "rounded-full border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          }
        >
          {definition.displayName}
        </button>
      ))}
    </div>
  );
};

const useSelectedSourceFrontendType = () => {
  const defaultDefinition = getDefaultSourceFrontendType();
  const [selectedKind, setSelectedKind] = useState<string | null>(
    defaultDefinition?.kind ?? null,
  );

  useEffect(() => {
    if (defaultDefinition === null) {
      setSelectedKind(null);
      return;
    }

    if (
      selectedKind === null
      || getSourceFrontendType(selectedKind) === null
    ) {
      setSelectedKind(defaultDefinition.kind);
    }
  }, [defaultDefinition, selectedKind]);

  return {
    selectedKind,
    setSelectedKind,
    definition:
      (selectedKind ? getSourceFrontendType(selectedKind) : null)
      ?? defaultDefinition,
  };
};

const SourcePluginAddLayout = (props: {
  compact?: boolean;
}) => {
  const { definition, selectedKind, setSelectedKind } =
    useSelectedSourceFrontendType();

  if (definition === null) {
    return (
      <SourcePluginsResetState
        title="Source plugins are unavailable"
        message="No source plugins are registered in this build."
      />
    );
  }

  return (
    <div
      className="mx-auto max-w-4xl overflow-scroll px-6 py-10 lg:px-10 lg:py-14"
      style={{ scrollBehavior: "auto" }}
    >
      {!props.compact && (
        <div className="mb-8">
          <div className="inline-flex rounded-full border border-border bg-muted px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Source Plugin
          </div>
          <h1 className="mt-5 font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            {definition.displayName}
          </h1>
        </div>
      )}
      <SourcePluginPicker
        selectedKind={selectedKind}
        onSelect={setSelectedKind}
      />
      {props.compact ? definition.renderAddPage() : definition.renderAddPage()}
    </div>
  );
};

export function SourcePluginAddPage() {
  return <SourcePluginAddLayout />;
}

export function SourcePluginCreatePage() {
  return <SourcePluginAddLayout compact />;
}

export function SourcePluginEditPage(input: {
  sourceId: string;
}) {
  const source = useSource(input.sourceId);

  return (
    <LoadableBlock loadable={source} loading="Loading source...">
      {(loadedSource) => {
        const definition = getSourceFrontendType(loadedSource.kind);
        if (definition?.renderEditPage === undefined) {
          return (
            <SourcePluginsResetState
              title="Source editing is disabled"
              message={`No frontend source plugin is registered for kind "${loadedSource.kind}".`}
            />
          );
        }

        return (
          <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
            {definition.renderEditPage({ source: loadedSource })}
          </div>
        );
      }}
    </LoadableBlock>
  );
}

export function SourcePluginDetailPage(input: {
  sourceId: string;
  search: SourcePluginRouteSearch;
  navigate: unknown;
}) {
  const source = useSource(input.sourceId);

  return (
    <LoadableBlock loadable={source} loading="Loading source...">
      {(loadedSource) => {
        const definition = getSourceFrontendType(loadedSource.kind);
        if (definition?.renderDetailPage === undefined) {
          return (
            <SourcePluginsResetState
              title="Source detail is disabled"
              message={`No frontend source plugin is registered for kind "${loadedSource.kind}".`}
            />
          );
        }

        return (
          <div className="h-full min-h-0">
            {definition.renderDetailPage({
              source: loadedSource,
              route: {
                search: input.search,
                navigate: input.navigate,
              },
            })}
          </div>
        );
      }}
    </LoadableBlock>
  );
}
