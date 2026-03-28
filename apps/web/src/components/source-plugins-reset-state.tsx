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
    <div className="min-h-0 flex-1 overflow-y-auto max-w-[300px]">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="rounded-2xl border border-border bg-card p-8">
          <h2 className="font-display text-xl tracking-tight text-foreground">
            {input.title}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {input.message}
          </p>
          {input.action ? <div className="mt-5">{input.action}</div> : null}
        </div>
      </div>
    </div>
  );
}
