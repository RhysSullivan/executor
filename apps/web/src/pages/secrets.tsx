import { useAtomValue, Result, secretsAtom } from "@executor/react";

export function SecretsPage() {
  const secrets = useAtomValue(secretsAtom());

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        {/* Header */}
        <div className="mb-8">
          <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Secrets
          </h1>
          <p className="mt-1.5 text-[14px] text-muted-foreground">
            Credentials and API keys for your connected sources.
          </p>
        </div>

        {Result.match(secrets, {
          onInitial: () => (
            <p className="text-sm text-muted-foreground">Loading secrets…</p>
          ),
          onFailure: () => (
            <p className="text-sm text-destructive">Failed to load secrets</p>
          ),
          onSuccess: ({ value }) =>
            value.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-4">
                  <svg viewBox="0 0 16 16" className="size-5">
                    <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </div>
                <p className="text-[14px] font-medium text-foreground/70 mb-1">
                  No secrets stored
                </p>
                <p className="text-[13px] text-muted-foreground/60">
                  Secrets are created when you configure authentication for a source.
                </p>
              </div>
            ) : (
              <div className="grid gap-2">
                {value.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-xl border border-border bg-card px-5 py-3.5 transition-colors hover:border-primary/25"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">{s.name}</p>
                      {s.purpose && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{s.purpose}</p>
                      )}
                    </div>
                    {s.provider && (
                      <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                        {s.provider}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ),
        })}
      </div>
    </div>
  );
}
