import type { SVGProps } from "react";

import { cn } from "../lib/cn";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

export function IconTool({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-4", className)} {...props}>
      <path d="M4 8h8M8 4v8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function IconSearch({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-4", className)} {...props}>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function IconChevron({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-3", className)} {...props}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconFolder({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-3", className)} {...props}>
      <path d="M2 4h5l2 2h5v7H2V4z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCopy({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-3.5", className)} {...props}>
      <rect x="5" y="5" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M11 3H4a1 1 0 00-1 1v7" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function IconCheck({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-3.5", className)} {...props}>
      <path d="M4 8.5l3 3 5-6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconClose({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-3", className)} {...props}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconEmpty({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 48 48" fill="none" className={cn("size-12", className)} {...props}>
      <rect x="6" y="6" width="36" height="36" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M16 18h16M16 24h12M16 30h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconSpinner({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-4 animate-spin", className)} {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" opacity="0.2" />
      <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconPencil({ className, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-4", className)} {...props}>
      <path d="M3 11.75L11.6 3.15a1.2 1.2 0 011.7 0l.55.55a1.2 1.2 0 010 1.7L5.25 14H3v-2.25z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.75 5l1.25 1.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
