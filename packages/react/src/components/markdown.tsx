import { isValidElement, Children, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { CodeBlock } from "./code-block";

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node) && node.props) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function PreBlock(props: { children?: ReactNode; node?: unknown }) {
  const child = Children.toArray(props.children)[0];
  if (
    isValidElement(child) &&
    (child.type === "code" || (child.props as Record<string, unknown>)?.className)
  ) {
    const childProps = child.props as { className?: string; children?: ReactNode };
    const lang = childProps.className?.replace("language-", "") ?? undefined;
    const code = extractText(childProps.children).replace(/\n$/, "");
    return <CodeBlock code={code} lang={lang} className="my-2" />;
  }
  return <pre>{props.children}</pre>;
}

const PROSE_CLASSES = [
  "text-sm leading-relaxed text-muted-foreground",
  // paragraphs
  "[&_p]:mb-[0.4em] [&_p:last-child]:mb-0",
  // bold
  "[&_strong]:text-foreground [&_strong]:font-semibold",
  "[&_b]:text-foreground [&_b]:font-semibold",
  // inline code
  "[&_code]:font-mono [&_code]:text-xs [&_code]:bg-muted [&_code]:border [&_code]:border-border",
  "[&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-px [&_code]:text-primary",
  // links
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_a]:decoration-primary/30 hover:[&_a]:decoration-primary/80",
  // lists
  "[&_ul]:pl-5 [&_ul]:my-1.5 [&_ol]:pl-5 [&_ol]:my-1.5",
  "[&_li]:mb-0.5 [&_li_::marker]:text-muted-foreground",
  // tables
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-xs [&_table]:my-2",
  "[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:bg-muted [&_th]:font-semibold [&_th]:text-foreground",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-left [&_td]:bg-background",
  // headings
  "[&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mt-2 [&_h1]:mb-1 [&_h1]:text-sm",
  "[&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mt-2 [&_h2]:mb-1 [&_h2]:text-sm",
  "[&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-xs",
  "[&_h4]:font-semibold [&_h4]:text-foreground [&_h4]:mt-2 [&_h4]:mb-1 [&_h4]:text-xs",
  // blockquote
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:my-1.5 [&_blockquote]:text-muted-foreground",
  // hr
  "[&_hr]:border-0 [&_hr]:border-t [&_hr]:border-border [&_hr]:my-2",
  // images
  "[&_img]:max-w-full [&_img]:rounded",
].join(" ");

export function Markdown(props: { children: string; className?: string }) {
  return (
    <div className={props.className ? `${PROSE_CLASSES} ${props.className}` : PROSE_CLASSES}>
      <Streamdown linkSafety={{ enabled: false }} components={{ pre: PreBlock as never }}>
        {props.children}
      </Streamdown>
    </div>
  );
}
