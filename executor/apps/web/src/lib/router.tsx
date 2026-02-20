"use client";

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { useEffect } from "react";
import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";

type NavigateOptions = {
  replace?: boolean;
};

type NavigateTarget = string | {
  to: string;
  search?: Record<string, string | number | boolean | null | undefined>;
};

function withSearch(
  to: string,
  search?: Record<string, string | number | boolean | null | undefined>,
): string {
  if (!search || Object.keys(search).length === 0) {
    return to;
  }

  const url = new URL(to, "http://localhost");
  for (const [key, value] of Object.entries(search)) {
    if (value === null || value === undefined || value === "") {
      url.searchParams.delete(key);
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const searchPart = url.searchParams.toString();
  return `${url.pathname}${searchPart ? `?${searchPart}` : ""}`;
}

function toHref(target: NavigateTarget): string {
  if (typeof target === "string") {
    return target;
  }

  return withSearch(target.to, target.search);
}

export function useNavigate() {
  const router = useRouter();

  return (to: NavigateTarget, options?: NavigateOptions) => {
    const href = toHref(to);
    if (options?.replace) {
      router.replace(href);
      return;
    }

    router.push(href);
  };
}

export function useLocation() {
  const pathname = usePathname() ?? "/";

  return {
    pathname,
    search: "",
    hash: "",
  };
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  children?: ReactNode | ((state: { isActive: boolean; isTransitioning: boolean }) => ReactNode);
  to: string;
  replace?: boolean;
  reloadDocument?: boolean;
};

function resolveChildren(
  children: LinkProps["children"],
): ReactNode {
  if (typeof children === "function") {
    return children({ isActive: false, isTransitioning: false });
  }

  return children;
}

export function Link({ reloadDocument, to, ...props }: LinkProps) {
  if (reloadDocument) {
    const href = to;
    const { children, ...anchorProps } = props;

    return (
      <a href={href} {...anchorProps}>
        {resolveChildren(children)}
      </a>
    );
  }

  const { children, replace, ...linkProps } = props;
  const resolvedChildren = resolveChildren(children);

  return (
    <NextLink href={to} replace={replace} {...linkProps}>
      {resolvedChildren as ReactNode}
    </NextLink>
  );
}

type NavigateProps = {
  to: string;
  replace?: boolean;
};

export function Navigate({ to, replace }: NavigateProps) {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(to, { replace });
  }, [navigate, replace, to]);

  return null;
}
