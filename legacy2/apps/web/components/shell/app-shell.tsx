"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ThemeSwitcher } from "./theme-switcher";
import { WorkspaceSelector } from "./workspace-selector";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  matchPrefixes?: ReadonlyArray<string>;
  children?: ReadonlyArray<NavItem>;
  badge?: ReactNode;
};

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  {
    href: "/tools",
    label: "Tools",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" className="size-4">
        <path
          d="M10.5 2.5L13.5 5.5L6 13H3V10L10.5 2.5Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    href: "/credentials",
    label: "Credentials",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" className="size-4">
        <rect x="2" y="6" width="12" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5 6V4.5a3 3 0 016 0V6" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="10" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    href: "/policies",
    label: "Policies",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" className="size-4">
        <path
          d="M8 1.5L13 4v4c0 3-2.5 5-5 6.5C5.5 13 3 11 3 8V4l5-2.5z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path d="M6 8l1.5 1.5L10.5 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: "/storage",
    label: "Storage",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" className="size-4">
        <ellipse cx="8" cy="4" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
        <path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4" stroke="currentColor" strokeWidth="1.3" />
        <path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
  },
  {
    href: "/approvals",
    label: "Approvals",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" className="size-4">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5.5 8l2 2 3.5-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" className="size-4">
        <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

const isActivePath = (pathname: string, item: NavItem): boolean => {
  if (item.matchPrefixes) {
    return item.matchPrefixes.some((prefix) => pathname.startsWith(prefix));
  }
  if (item.href === "/") {
    return pathname === "/";
  }
  return pathname.startsWith(item.href);
};

type AppShellProps = {
  children: ReactNode;
  authEnabled: boolean;
  approvalsBadge?: ReactNode;
};

export function AppShell({
  children,
  authEnabled,
  approvalsBadge,
}: AppShellProps) {
  const pathname = usePathname();

  // Compact chrome: pages that manage their own scroll (full-viewport layout)
  const useCompactChrome =
    pathname.startsWith("/tools") ||
    pathname.startsWith("/approvals");
  return (
    <div className="flex h-screen overflow-hidden">
      {/* ---- Sidebar ---- */}
      <aside className="flex w-[220px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
        {/* Logo / brand */}
        <div className="border-b border-sidebar-border px-3 py-2">
          <div className="min-w-0">
            <WorkspaceSelector />
          </div>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-2 py-2">
          <ul className="space-y-0.5">
            {NAV_ITEMS.map((item) => {
              const active = isActivePath(pathname, item);
              const isApprovals = item.href === "/approvals";

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                      active
                        ? "bg-sidebar-active text-sidebar-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-active/50 hover:text-sidebar-foreground"
                    )}
                  >
                    <span className={cn(
                      "shrink-0 transition-colors",
                      active ? "text-primary-foreground" : "text-sidebar-foreground/70 group-hover:text-sidebar-foreground",
                    )}>
                      {item.icon}
                    </span>
                    <span className="flex-1 truncate">{item.label}</span>
                    {isApprovals && approvalsBadge ? approvalsBadge : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Footer */}
        <div className="border-t border-sidebar-border px-3 py-2">
          <ThemeSwitcher />
        </div>

        <div className="border-t border-sidebar-border px-3 py-2.5">
          {authEnabled ? (
            <a
              href="/sign-out"
              className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px] text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground"
            >
              <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
                <path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M11 11l3-3-3-3M6 8h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Sign out
            </a>
          ) : (
            <span className="text-[10px] text-sidebar-foreground/40">Local mode</span>
          )}
        </div>
      </aside>

      {/* ---- Main content ---- */}
      <main
        className={cn(
          "flex-1 min-w-0 flex flex-col",
          useCompactChrome
            ? "overflow-hidden"
            : "overflow-y-auto p-4 md:p-6 lg:p-8",
        )}
      >
        {children}
      </main>
    </div>
  );
}
