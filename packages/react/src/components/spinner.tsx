import { Loader2Icon } from "lucide-react";

import { cn } from "../lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

const IOS_SPINNER_BLADES = 12;

function IOSSpinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      role="status"
      aria-label="Loading"
      viewBox="0 0 24 24"
      className={cn("size-4 text-muted-foreground", className)}
      {...props}
    >
      {Array.from({ length: IOS_SPINNER_BLADES }).map((_, i) => (
        <rect
          key={i}
          x="11"
          y="2"
          width="2"
          height="6"
          rx="1"
          fill="currentColor"
          transform={`rotate(${(360 / IOS_SPINNER_BLADES) * i} 12 12)`}
          style={{
            animation: "ios-spinner-fade 1s linear infinite",
            animationDelay: `${(i / IOS_SPINNER_BLADES) * 1 - 1}s`,
            opacity: 0.25,
          }}
        />
      ))}
    </svg>
  );
}

export { Spinner, IOSSpinner };
