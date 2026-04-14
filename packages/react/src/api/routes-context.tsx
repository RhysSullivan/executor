import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";

// ---------------------------------------------------------------------------
// Routes context
// ---------------------------------------------------------------------------
//
// Shared pages (sources, source-detail, sources-add) and shared components
// (command-palette) need to navigate to app-specific routes. Cloud mounts
// these under `/$org/*` (org-scoped) while local mounts them at the root.
// Instead of hardcoding route literals inside the shared package, each host
// app provides an `AppRoutes` object that returns concrete TanStack Router
// `to`/`params`/`search` triples. Shared components consume it via
// `useRoutes()` and render links via `<RouteLink>`.
// ---------------------------------------------------------------------------

export type RouteTarget = {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
  replace?: boolean;
};

export interface AppRoutes {
  home: RouteTarget;
  sourceDetail: (sourceId: string) => RouteTarget;
  sourcesAdd: (pluginKey: string, search?: Record<string, unknown>) => RouteTarget;
}

const RoutesContext = React.createContext<AppRoutes | null>(null);

export function RoutesProvider(props: { value: AppRoutes; children: React.ReactNode }) {
  return <RoutesContext.Provider value={props.value}>{props.children}</RoutesContext.Provider>;
}

export function useRoutes(): AppRoutes {
  const ctx = React.useContext(RoutesContext);
  if (ctx === null) {
    throw new Error("useRoutes must be used inside a RoutesProvider");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// RouteLink — spreads a RouteTarget onto TanStack `<Link>`.
//
// TanStack Router's Link types are derived from the generated route tree,
// which is per-app. Shared package can't know that tree, so we cast here —
// host apps are responsible for returning valid targets from their
// AppRoutes implementation.
// ---------------------------------------------------------------------------

type LinkOwnProps = Omit<
  React.ComponentProps<"a">,
  "href" | "onClick" | "onFocus" | "onMouseEnter" | "onTouchStart"
>;

export function RouteLink(
  props: LinkOwnProps & {
    route: RouteTarget;
    children?: React.ReactNode;
  },
) {
  const { route, children, ...rest } = props;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const LinkAny = Link as any;
  return (
    <LinkAny {...(route as Record<string, unknown>)} {...rest}>
      {children}
    </LinkAny>
  );
}

// ---------------------------------------------------------------------------
// useAppNavigate — a typed-loose wrapper around useNavigate.
// ---------------------------------------------------------------------------

export function useAppNavigate(): (target: RouteTarget) => void {
  const navigate = useNavigate();
  return React.useCallback(
    (target: RouteTarget) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (navigate as any)(target);
    },
    [navigate],
  );
}
