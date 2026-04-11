import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "./button";
import { cn } from "../lib/utils";

function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (label) {
    return (
      <Button
        variant="ghost"
        size="xs"
        onClick={handleCopy}
        className={cn("text-muted-foreground", className)}
        title={label}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : label}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={handleCopy}
      className={cn("shrink-0 text-muted-foreground", className)}
      title="Copy"
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export { CopyButton };
