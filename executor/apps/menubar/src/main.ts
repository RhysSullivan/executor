import { app, Menu, Notification, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@executor/convex/_generated/api";
import type { Id } from "@executor/convex/_generated/dataModel";

type ApprovalDecision = "approved" | "denied";

type PendingApprovalRecord = {
  id: string;
  taskId: string;
  toolPath: string;
  createdAt: number;
};

type WorkspaceListItem = {
  id: Id<"workspaces">;
  name: string;
};

type AnonymousContext = {
  sessionId: string;
  workspaceId: Id<"workspaces">;
};

type RuntimeConfig = {
  convexUrl: string;
  workspaceId?: Id<"workspaces">;
  sessionId?: string;
  authToken?: string;
  pollIntervalMs: number;
};

type RuntimeContext = {
  workspaceId: Id<"workspaces">;
  sessionId?: string;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;

const DEFAULT_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ioAAAAASUVORK5CYII=";

function parseWorkspaceId(value: string | undefined): Id<"workspaces"> | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? (trimmed as Id<"workspaces">) : undefined;
}

function parseOptionalString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parsePollInterval(value: string | undefined): number {
  if (!value) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1_000) {
    throw new Error("EXECUTOR_POLL_INTERVAL_MS must be a number >= 1000");
  }
  return parsed;
}

function readConfigFromEnv(): RuntimeConfig {
  const convexUrl = parseOptionalString(process.env.CONVEX_URL);
  if (!convexUrl) {
    throw new Error("CONVEX_URL is required");
  }

  return {
    convexUrl,
    workspaceId: parseWorkspaceId(process.env.EXECUTOR_WORKSPACE_ID),
    sessionId: parseOptionalString(process.env.EXECUTOR_SESSION_ID),
    authToken: parseOptionalString(process.env.EXECUTOR_AUTH_TOKEN),
    pollIntervalMs: parsePollInterval(process.env.EXECUTOR_POLL_INTERVAL_MS),
  };
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function formatTimeAgo(timestamp: number): string {
  const elapsedMs = Date.now() - timestamp;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return "now";
  }

  const elapsedSec = Math.floor(elapsedMs / 1_000);
  if (elapsedSec < 60) {
    return `${elapsedSec}s ago`;
  }

  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) {
    return `${elapsedMin}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMin / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

class ApprovalMenubarApp {
  private readonly convex: ConvexHttpClient;
  private readonly inFlightApprovalIds = new Set<string>();
  private readonly seenApprovalIds = new Set<string>();
  private readonly icon = nativeImage.createFromDataURL(DEFAULT_ICON_DATA_URL);
  private context: RuntimeContext | null = null;
  private tray: Tray | null = null;
  private approvals: PendingApprovalRecord[] = [];
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight = false;
  private lastError: string | null = null;

  constructor(private readonly config: RuntimeConfig) {
    this.convex = new ConvexHttpClient(config.convexUrl);
    if (config.authToken) {
      this.convex.setAuth(config.authToken);
    }
  }

  async start(): Promise<void> {
    this.context = await this.resolveContext();
    this.tray = new Tray(this.icon);
    this.tray.setToolTip("Executor task approvals");

    if (isMacOS()) {
      this.tray.setTitle("Exec");
    }

    this.updateMenu();
    await this.refreshApprovals({ initial: true });

    this.pollingTimer = setInterval(() => {
      void this.refreshApprovals({ initial: false });
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private async resolveContext(): Promise<RuntimeContext> {
    let sessionId = this.config.sessionId;
    let workspaceId = this.config.workspaceId;

    if (!this.config.authToken) {
      const bootstrapped = await this.convex.mutation(api.workspace.bootstrapAnonymousSession, {
        sessionId,
      }) as AnonymousContext;

      sessionId = bootstrapped.sessionId;
      if (!workspaceId) {
        workspaceId = bootstrapped.workspaceId;
      }
    }

    if (!workspaceId) {
      const workspaces = await this.convex.query(api.workspaces.list, {
        sessionId,
      }) as WorkspaceListItem[];

      workspaceId = workspaces[0]?.id;
    }

    if (!workspaceId) {
      throw new Error(
        "Could not determine workspace. Set EXECUTOR_WORKSPACE_ID or provide session/auth that can access a workspace.",
      );
    }

    return {
      workspaceId,
      sessionId,
    };
  }

  private async refreshApprovals(options: { initial: boolean }): Promise<void> {
    if (!this.context || this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;
    try {
      const approvals = await this.convex.query(api.workspace.listPendingApprovals, {
        workspaceId: this.context.workspaceId,
        sessionId: this.context.sessionId,
      }) as PendingApprovalRecord[];

      this.lastError = null;
      this.handleNotifications(approvals, options.initial);
      this.approvals = approvals;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Failed to load approvals";
    } finally {
      this.refreshInFlight = false;
      this.updateMenu();
    }
  }

  private handleNotifications(nextApprovals: PendingApprovalRecord[], initial: boolean): void {
    const currentIds = new Set(nextApprovals.map((approval) => approval.id));

    if (initial) {
      this.seenApprovalIds.clear();
      currentIds.forEach((id) => this.seenApprovalIds.add(id));
      return;
    }

    const newApprovals = nextApprovals.filter((approval) => !this.seenApprovalIds.has(approval.id));
    this.seenApprovalIds.clear();
    currentIds.forEach((id) => this.seenApprovalIds.add(id));

    if (newApprovals.length === 0) {
      return;
    }

    const newest = newApprovals[newApprovals.length - 1];
    const body = newApprovals.length === 1
      ? `Task ${newest.taskId} is waiting on ${newest.toolPath}`
      : `${newApprovals.length} approvals are waiting for review`;

    new Notification({
      title: "Executor approval required",
      body,
      silent: false,
    }).show();
  }

  private setTrayTitle(count: number): void {
    if (!this.tray) {
      return;
    }

    const label = count > 0 ? `Exec ${count}` : "Exec";
    if (isMacOS()) {
      this.tray.setTitle(label);
    }
    this.tray.setToolTip(`Executor approvals (${count} pending)`);
  }

  private updateMenu(): void {
    if (!this.tray || !this.context) {
      return;
    }

    this.setTrayTitle(this.approvals.length);

    const menuTemplate: MenuItemConstructorOptions[] = [
      {
        label: `Workspace: ${this.context.workspaceId}`,
        enabled: false,
      },
      {
        label: `${this.approvals.length} pending approval${this.approvals.length === 1 ? "" : "s"}`,
        enabled: false,
      },
    ];

    if (this.lastError) {
      menuTemplate.push(
        { type: "separator" },
        {
          label: `Error: ${truncate(this.lastError, 64)}`,
          enabled: false,
        },
      );
    }

    menuTemplate.push({ type: "separator" });

    if (this.approvals.length === 0) {
      menuTemplate.push({
        label: "No pending approvals",
        enabled: false,
      });
    } else {
      this.approvals.forEach((approval) => {
        const isResolving = this.inFlightApprovalIds.has(approval.id);
        menuTemplate.push({
          label: truncate(`${approval.toolPath} (${formatTimeAgo(approval.createdAt)})`, 56),
          submenu: [
            {
              label: `Task: ${approval.taskId}`,
              enabled: false,
            },
            {
              label: `Approval ID: ${approval.id}`,
              enabled: false,
            },
            {
              type: "separator",
            },
            {
              label: isResolving ? "Approving..." : "Approve",
              enabled: !isResolving,
              click: () => {
                void this.resolveApproval(approval.id, "approved");
              },
            },
            {
              label: isResolving ? "Denying..." : "Deny",
              enabled: !isResolving,
              click: () => {
                void this.resolveApproval(approval.id, "denied");
              },
            },
          ],
        });
      });
    }

    menuTemplate.push(
      { type: "separator" },
      {
        label: "Refresh now",
        click: () => {
          void this.refreshApprovals({ initial: false });
        },
      },
      {
        label: "Quit",
        role: "quit",
      },
    );

    this.tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
  }

  private async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.context || this.inFlightApprovalIds.has(approvalId)) {
      return;
    }

    this.inFlightApprovalIds.add(approvalId);
    this.updateMenu();

    try {
      await this.convex.mutation(api.executor.resolveApproval, {
        workspaceId: this.context.workspaceId,
        sessionId: this.context.sessionId,
        approvalId,
        decision,
      });

      new Notification({
        title: decision === "approved" ? "Approval approved" : "Approval denied",
        body: `${approvalId} was ${decision}`,
        silent: false,
      }).show();

      await this.refreshApprovals({ initial: false });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Failed to resolve approval";
      new Notification({
        title: "Executor approval action failed",
        body: this.lastError,
        silent: false,
      }).show();
    } finally {
      this.inFlightApprovalIds.delete(approvalId);
      this.updateMenu();
    }
  }
}

let approvalApp: ApprovalMenubarApp | null = null;

app.whenReady().then(async () => {
  if (isMacOS()) {
    app.dock?.hide();
  }

  const config = readConfigFromEnv();
  approvalApp = new ApprovalMenubarApp(config);
  await approvalApp.start();
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[executor-menubar] ${message}`);
  app.quit();
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  approvalApp?.stop();
});
