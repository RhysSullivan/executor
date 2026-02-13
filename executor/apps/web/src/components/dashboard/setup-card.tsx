import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type SetupStep = {
  label: string;
  done: boolean;
  href: string;
  pendingText: string;
  doneText: string;
};

export function DashboardSetupCard({
  taskCount,
  setupSteps,
}: {
  taskCount: number;
  setupSteps: SetupStep[];
}) {
  const navigate = useNavigate();

  return (
    <Card className="border-border bg-gradient-to-br from-card to-muted/25">
      <CardContent className="p-5 md:p-6 space-y-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1.5 max-w-2xl">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Landing View</p>
            <h2 className="text-lg font-semibold tracking-tight">
              {taskCount === 0
                ? "Connect tools and run your first task"
                : "Your editor and approval queue are live"}
            </h2>
            <p className="text-sm text-muted-foreground">
              Use the editor in Tools for direct code execution and check approvals as needed.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" className="h-8 text-xs" onClick={() => navigate("/tools?tab=editor")}>
              Open editor
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => navigate("/tools")}>
              Manage tools
            </Button>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          {setupSteps.map((step) => (
            <button
              type="button"
              key={step.label}
              onClick={() => navigate(step.href)}
              className="rounded-md border border-border/70 bg-background/70 px-3 py-2.5 hover:bg-accent/25 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground">{step.label}</span>
                {step.done ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-terminal-green" />
                ) : (
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {step.done ? step.doneText : step.pendingText}
              </p>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
