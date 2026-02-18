import { useMemo, type ComponentProps } from "react";
import {
  Link as TanStackLink,
  Navigate as TanStackNavigate,
  useLocation as useTanStackLocation,
  useNavigate as useTanStackNavigate,
} from "@tanstack/react-router";

type NavigateOptions = {
  replace?: boolean;
};

export function useNavigate() {
  const navigate = useTanStackNavigate();

  return (to: string, options?: NavigateOptions) => {
    void navigate({
      to,
      replace: options?.replace,
    });
  };
}

export function useLocation() {
  return useTanStackLocation();
}

export function useSearchParams(): readonly [URLSearchParams] {
  const location = useTanStackLocation();

  const searchParams = useMemo(() => {
    return new URLSearchParams(location.searchStr);
  }, [location.searchStr]);

  return [searchParams] as const;
}

type LinkProps = ComponentProps<typeof TanStackLink> & {
  reloadDocument?: boolean;
};

export function Link({ reloadDocument, to, ...props }: LinkProps) {
  if (reloadDocument) {
    const href = typeof to === "string" ? to : "#";
    const { children, ...anchorProps } = props;

    return (
      <a href={href} {...(anchorProps as ComponentProps<"a">)}>
        {typeof children === "function"
          ? children({ isActive: false, isTransitioning: false })
          : children}
      </a>
    );
  }

  return <TanStackLink to={to} {...props} />;
}

type NavigateProps = {
  to: string;
  replace?: boolean;
};

export function Navigate({ to, replace }: NavigateProps) {
  return <TanStackNavigate to={to} replace={replace} />;
}
