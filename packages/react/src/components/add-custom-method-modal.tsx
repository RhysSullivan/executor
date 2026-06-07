import { useState } from "react";

import { emptyPlacement, type AuthMethod, type Placement } from "../lib/auth-placements";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Input } from "./input";
import { Label } from "./label";
import { PlacementEditor } from "./placement-editor";

// ---------------------------------------------------------------------------
// Add custom auth method — apiKey-only, plugin-agnostic.
//
// A custom method is reusable: any account on this integration can pick it. The
// user names it and declares one or more PLACEMENTS (where the credential goes).
// This component owns the UI; the plugin-specific persistence (mapping generic
// placements to its wire template + the configure mutation) is INJECTED via
// `onCreate`, so `packages/react` never imports a plugin package (the dependency
// runs the other way). OAuth is never offered here — custom methods are
// apiKey-only (decided).
// ---------------------------------------------------------------------------

/** Persist a custom method built from the user's placements. Returns the
 *  created `AuthMethod` (so the caller can select it) or `null` on failure. The
 *  plugin binds this to its own template converter + configure mutation. */
export type CreateCustomMethod = (input: {
  readonly label: string;
  readonly placements: readonly Placement[];
}) => Promise<AuthMethod | null>;

export function AddCustomMethodModal(props: {
  readonly integrationName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: CreateCustomMethod;
  readonly onCreated: (method: AuthMethod) => void;
}) {
  const { integrationName, open, onOpenChange, onCreate, onCreated } = props;

  const [label, setLabel] = useState("");
  const [placements, setPlacements] = useState<Placement[]>([emptyPlacement()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namedPlacements = placements.filter((p: Placement) => p.name.trim().length > 0);
  const canSubmit = !submitting && namedPlacements.length > 0;

  const reset = () => {
    setLabel("");
    setPlacements([emptyPlacement()]);
    setSubmitting(false);
    setError(null);
  };

  const close = () => {
    onOpenChange(false);
    reset();
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const created = await onCreate({ label: label.trim(), placements: namedPlacements });
    if (created === null) {
      setSubmitting(false);
      setError("Failed to add method. Please try again.");
      return;
    }
    onCreated(created);
    close();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next: boolean) => {
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add auth method · {integrationName}</DialogTitle>
          <DialogDescription>
            A reusable method — any account on this integration can pick it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="space-y-2">
            <Label htmlFor="custom-method-name" className="text-xs text-muted-foreground">
              Method name
            </Label>
            <Input
              id="custom-method-name"
              placeholder="e.g. API key (X-Custom-Token)"
              value={label}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLabel(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Where does the credential go?</Label>
            <PlacementEditor placements={placements} onChange={setPlacements} />
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {submitting ? "Adding…" : "Add method"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
