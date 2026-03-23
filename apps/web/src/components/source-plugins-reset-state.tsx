import type { ReactNode } from "react";

type SourcePluginsResetStateProps = {
  title: string;
  message: string;
  action?: ReactNode;
};

export function SourcePluginsResetState(
  input: SourcePluginsResetStateProps,
) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="rounded-3xl border border-border bg-card p-8 shadow-[0_20px_60px_-40px_rgba(15,23,42,0.35)]">
          <div className="inline-flex rounded-full border border-border bg-muted px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Clean Slate
          </div>
          <h1 className="mt-5 font-display text-3xl tracking-tight text-foreground">
            {input.title}
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
            {input.message}
          </p>
          {input.action ? <div className="mt-6">{input.action}</div> : null}
        </div>
      </div>
    </div>
  );
}
