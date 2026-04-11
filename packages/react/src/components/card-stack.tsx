import * as React from "react";
import { PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { Collapsible as CollapsiblePrimitive, Slot } from "radix-ui";

import { cn } from "../lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";

type CardStackContextValue = {
  collapsible: boolean;
  searchable: boolean;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
};

const CardStackContext = React.createContext<CardStackContextValue>({
  collapsible: false,
  searchable: false,
  searchQuery: "",
  setSearchQuery: () => {},
});

type CardStackProps = React.ComponentProps<"div"> & {
  collapsible?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * When true, renders a compact search input in the header and filters
   * entries whose `searchText` prop does not match the query.
   */
  searchable?: boolean;
  searchQuery?: string;
  defaultSearchQuery?: string;
  onSearchChange?: (query: string) => void;
};

function CardStack({
  className,
  collapsible = false,
  defaultOpen,
  open,
  onOpenChange,
  searchable = false,
  searchQuery: searchQueryProp,
  defaultSearchQuery = "",
  onSearchChange,
  ...props
}: CardStackProps) {
  const [uncontrolledQuery, setUncontrolledQuery] = React.useState(defaultSearchQuery);
  const searchQuery = searchQueryProp ?? uncontrolledQuery;
  const setSearchQuery = React.useCallback(
    (query: string) => {
      if (searchQueryProp === undefined) setUncontrolledQuery(query);
      onSearchChange?.(query);
    },
    [searchQueryProp, onSearchChange],
  );

  const contextValue = React.useMemo(
    () => ({ collapsible, searchable, searchQuery, setSearchQuery }),
    [collapsible, searchable, searchQuery, setSearchQuery],
  );

  const card = (
    <div
      data-slot="card-stack"
      data-collapsible={collapsible || undefined}
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-border/50 bg-card text-card-foreground focus-within:!opacity-100",
        className,
      )}
      {...props}
    />
  );

  if (collapsible) {
    return (
      <CardStackContext.Provider value={contextValue}>
        <CollapsiblePrimitive.Root
          defaultOpen={defaultOpen ?? true}
          open={open}
          onOpenChange={onOpenChange}
          asChild
        >
          {card}
        </CollapsiblePrimitive.Root>
      </CardStackContext.Provider>
    );
  }

  return <CardStackContext.Provider value={contextValue}>{card}</CardStackContext.Provider>;
}

function CardStackSearchInput() {
  const { searchQuery, setSearchQuery } = React.useContext(CardStackContext);
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div
      data-slot="card-stack-search"
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-muted-foreground focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/40"
      onClick={(event) => event.stopPropagation()}
    >
      <SearchIcon aria-hidden className="size-3.5 shrink-0" />
      <Input
        type="text"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        placeholder="Search…"
        aria-label="Search entries"
        className="h-5 w-32 rounded-none border-0 bg-transparent p-0 text-xs text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 md:text-xs dark:bg-transparent"
      />
      {searchQuery && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Clear search"
          onClick={() => setSearchQuery("")}
          className="size-4 rounded-sm text-muted-foreground transition-[color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-transparent hover:text-foreground"
        >
          <XIcon aria-hidden className="size-3" />
        </Button>
      )}
    </div>
  );
}

type CardStackHeaderProps = React.HTMLAttributes<HTMLElement> & {
  /**
   * Content rendered on the right side of the header, after the title and
   * (optional) search input. Useful for action buttons like "Add Header".
   */
  rightSlot?: React.ReactNode;
};

function CardStackHeader({ className, children, rightSlot, ...props }: CardStackHeaderProps) {
  const { collapsible, searchable } = React.useContext(CardStackContext);

  const title = <span className="min-w-0 flex-1 truncate">{children}</span>;

  if (collapsible) {
    return (
      <CollapsiblePrimitive.Trigger
        data-slot="card-stack-header"
        className={cn(
          "group/card-stack-header flex w-full items-center justify-between gap-4 px-4 py-3 text-left text-sm font-medium outline-none transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent/40 focus-visible:bg-accent/40",
          className,
        )}
        {...props}
      >
        {title}
        {searchable && <CardStackSearchInput />}
        {rightSlot}
        <PlusIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] group-data-[state=open]/card-stack-header:rotate-45"
        />
      </CollapsiblePrimitive.Trigger>
    );
  }

  return (
    <div
      data-slot="card-stack-header"
      className={cn(
        "flex w-full items-center justify-between gap-4 px-4 py-3 text-sm font-medium",
        className,
      )}
      {...props}
    >
      {title}
      {searchable && <CardStackSearchInput />}
      {rightSlot}
    </div>
  );
}

function CardStackHeaderAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-stack-header-action"
      className={cn("flex shrink-0 items-center gap-1 text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardStackContent({ className, ...props }: React.ComponentProps<"div">) {
  const { collapsible } = React.useContext(CardStackContext);

  if (collapsible) {
    return (
      <CollapsiblePrimitive.Content className="overflow-hidden transition-[height] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] data-[state=closed]:h-0 data-[state=open]:h-[var(--radix-collapsible-content-height)]">
        <div
          data-slot="card-stack-content"
          className={cn(
            "flex flex-col border-t border-border/50 first:border-t-0",
            "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-0 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-border/50",
            className,
          )}
          {...props}
        />
      </CollapsiblePrimitive.Content>
    );
  }

  return (
    <div
      data-slot="card-stack-content"
      className={cn(
        "flex flex-col border-t border-border/50 first:border-t-0",
        "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-0 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-border/50",
        className,
      )}
      {...props}
    />
  );
}

type CardStackEntryProps = React.ComponentProps<"div"> & {
  asChild?: boolean;
  /**
   * Text used to match against the parent `CardStack`'s search query when
   * `searchable` is enabled. When omitted, the entry is always shown.
   */
  searchText?: string;
};

function CardStackEntry({ className, asChild = false, searchText, ...props }: CardStackEntryProps) {
  const { searchable, searchQuery } = React.useContext(CardStackContext);

  if (searchable && searchText !== undefined) {
    const trimmed = searchQuery.trim().toLowerCase();
    if (trimmed.length > 0 && !searchText.toLowerCase().includes(trimmed)) {
      return null;
    }
  }

  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="card-stack-entry"
      className={cn(
        "group/card-stack-entry flex w-full items-center gap-3 px-4 py-3 text-sm outline-none transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
        "focus-visible:bg-accent/40",
        "[&[href]]:cursor-pointer [&[href]]:hover:bg-accent/40",
        className,
      )}
      {...props}
    />
  );
}

type CardStackEntryFieldProps = React.ComponentProps<"div"> & {
  label?: React.ReactNode;
  description?: React.ReactNode;
  hint?: React.ReactNode;
  labelAction?: React.ReactNode;
};

/**
 * Form-field variant of `CardStackEntry` — stacks a label, form control, and
 * optional hint vertically. Use inside a `CardStack` to render consistent
 * bordered form fields. Consumers pass the form control (Input, Textarea,
 * etc.) as children.
 */
function CardStackEntryField({
  className,
  label,
  description,
  hint,
  labelAction,
  children,
  ...props
}: CardStackEntryFieldProps) {
  return (
    <div
      data-slot="card-stack-entry-field"
      className={cn(
        "group/card-stack-entry flex w-full flex-col items-stretch gap-2 px-4 py-3 text-sm outline-none",
        "focus-visible:bg-accent/40",
        className,
      )}
      {...props}
    >
      {(label || labelAction) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <Label className="text-sm font-medium">
              {label}
              {description && (
                <span className="font-normal text-muted-foreground"> {description}</span>
              )}
            </Label>
          )}
          {labelAction}
        </div>
      )}
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

function CardStackEntryMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-stack-entry-media"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_img]:size-full [&_img]:rounded-[inherit] [&_img]:object-cover [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function CardStackEntryContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-stack-entry-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)}
      {...props}
    />
  );
}

function CardStackEntryTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-stack-entry-title"
      className={cn("truncate text-sm font-medium leading-snug", className)}
      {...props}
    />
  );
}

function CardStackEntryDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="card-stack-entry-description"
      className={cn("truncate text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardStackEntryActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-stack-entry-actions"
      className={cn("flex shrink-0 items-center gap-2 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardStackEmpty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-stack-empty"
      className={cn(
        "flex w-full items-center justify-between gap-4 px-4 py-3 text-sm text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  CardStack,
  CardStackHeader,
  CardStackHeaderAction,
  CardStackContent,
  CardStackEntry,
  CardStackEntryField,
  CardStackEntryMedia,
  CardStackEntryContent,
  CardStackEntryTitle,
  CardStackEntryDescription,
  CardStackEntryActions,
  CardStackEmpty,
};
