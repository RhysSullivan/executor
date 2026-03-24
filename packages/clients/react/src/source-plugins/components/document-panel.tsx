import { cn } from "../lib/cn";
import { CodeBlock } from "./code-block";

export function DocumentPanel(props: {
  title: string;
  body: string | null;
  lang?: string;
  empty: string;
  compact?: boolean;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card/60",
        props.compact && "min-h-48",
      )}
    >
      <div className="border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {props.title}
      </div>
      {props.body ? (
        <CodeBlock code={props.body} lang={props.lang} className="max-h-[32rem]" />
      ) : (
        <div className="flex items-center justify-center p-6 text-[13px] text-muted-foreground/40">
          {props.empty}
        </div>
      )}
    </section>
  );
}
