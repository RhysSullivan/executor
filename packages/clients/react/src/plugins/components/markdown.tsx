import { Streamdown } from "streamdown";

import { createLimitedCodePlugin } from "../lib/shiki";

const codePlugin = createLimitedCodePlugin();

const PROSE_CLASSES = [
  "text-[13px] leading-relaxed text-muted-foreground",
  "[&_p]:mb-[0.4em] [&_p:last-child]:mb-0",
  "[&_strong]:text-foreground [&_strong]:font-semibold",
  "[&_b]:text-foreground [&_b]:font-semibold",
  "[&_code]:font-mono [&_code]:text-xs [&_code]:bg-muted [&_code]:border [&_code]:border-border",
  "[&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-px [&_code]:text-primary",
  "[&_pre]:bg-muted [&_pre]:border [&_pre]:border-border [&_pre]:rounded-md",
  "[&_pre]:px-3 [&_pre]:py-2 [&_pre]:overflow-x-auto [&_pre]:my-2 [&_pre]:text-xs [&_pre]:leading-relaxed",
  "[&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0 [&_pre_code]:text-inherit",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_a]:decoration-primary/30 hover:[&_a]:decoration-primary/80",
  "[&_ul]:pl-5 [&_ul]:my-1.5 [&_ol]:pl-5 [&_ol]:my-1.5",
  "[&_li]:mb-0.5 [&_li_::marker]:text-muted-foreground",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_table]:my-2",
  "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:bg-muted [&_th]:font-semibold [&_th]:text-foreground",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-left [&_td]:bg-background",
  "[&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-[15px]",
  "[&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-sm",
  "[&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-[13px]",
  "[&_h4]:font-semibold [&_h4]:text-foreground [&_h4]:mt-2 [&_h4]:mb-1 [&_h4]:text-[13px]",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:my-1.5 [&_blockquote]:text-muted-foreground",
  "[&_hr]:border-0 [&_hr]:border-t [&_hr]:border-border [&_hr]:my-2",
  "[&_img]:max-w-full [&_img]:rounded",
].join(" ");

export function Markdown(props: { children: string; className?: string }) {
  return (
    <div className={props.className ? `${PROSE_CLASSES} ${props.className}` : PROSE_CLASSES}>
      <Streamdown plugins={{ code: codePlugin }} controls={{ code: true }} linkSafety={{ enabled: false }}>
        {props.children}
      </Streamdown>
    </div>
  );
}
