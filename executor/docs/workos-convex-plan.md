# WorkOS + Convex: Auth & Multi-Tenancy Plan

## Core Constraint: WorkOS is Optional, Anonymous Demo is First-Class

Anonymous usage must work in both local and hosted deployments.

- If WorkOS is not configured, app runs in anonymous mode only.
- If WorkOS is configured, app supports both:
  - anonymous demo entry (guest workspace), and
  - full WorkOS sign-in (multi-account, multi-workspace).

## Auth Capability Detection

```ts
// Convex backend: process.env.WORKOS_CLIENT_ID
// Next.js client: process.env.NEXT_PUBLIC_WORKOS_CLIENT_ID
const workosEnabled = !!WORKOS_CLIENT_ID;
const anonymousDemoEnabled = process.env.EXECUTOR_ALLOW_ANON_DEMO !== "0";
```

`workosEnabled` controls whether WorkOS routes/webhooks are active.
`anonymousDemoEnabled` controls whether guest entry is shown (default on).

## Data Model

Three core entities. Same tables in both modes. Only how records are
created differs.

```
account (1) ──── (*) user (*)  ──── (1) workspace
   │                                      │
   │  "I signed in with this email"       │  "all data lives here"
   │  (or: "I'm in guest mode")           │
   │                                      │
   └── provider, email, name              └── tasks, approvals, tools, etc.
```

### account

A login identity. Provider-agnostic. In WorkOS mode: 1:1 with a WorkOS
user, synced via webhooks. In anonymous mode: guest account/session rows.

```ts
accounts: defineTable({
  provider: v.string(),               // "workos" | "anonymous"
  providerAccountId: v.string(),      // user_id, or anonymous session/account id
  email: v.string(),
  name: v.string(),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  avatarUrl: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_provider", ["provider", "providerAccountId"])
  .index("by_email", ["email"])
```

### workspace

The tenant boundary. All domain data (tasks, approvals, tools, credentials,
policies) belongs to a workspace. A workspace can be backed by a WorkOS
organization, or be a personal workspace with no org.

```ts
workspaces: defineTable({
  workosOrgId: v.optional(v.string()),  // WorkOS org ID (org_*), null = personal
  slug: v.string(),
  name: v.string(),
  plan: v.string(),                     // "free" | "pro" | "enterprise"
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_workos_org_id", ["workosOrgId"])
  .index("by_slug", ["slug"])
```

### user

A user is an account's membership in a specific workspace. One account can
have many users (one per workspace). This is the join table and also carries
the role/status within that workspace.

```ts
users: defineTable({
  accountId: v.id("accounts"),
  workspaceId: v.id("workspaces"),
  workosOrgMembershipId: v.optional(v.string()),  // WorkOS om_* ID
  role: v.string(),                                // "owner" | "admin" | "member"
  status: v.string(),                              // "active" | "pending" | "suspended"
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_account_workspace", ["accountId", "workspaceId"])
  .index("by_account", ["accountId"])
  .index("by_workspace", ["workspaceId"])
  .index("by_workspace_role", ["workspaceId", "role"])
  .index("by_workos_membership_id", ["workosOrgMembershipId"])
```

---

## Client-Side: Guest + WorkOS Paths

### Guest path (always available by default)

On first load, guest bootstrap creates anonymous account + workspace + user
(idempotent). Session context exposes the IDs. This is available locally and
hosted for demos unless explicitly disabled.

### WorkOS path (when configured)

Browser holds **multiple WorkOS tokens** — one per signed-in account. UI
lets you switch between accounts and between workspaces within an account.

**Token storage:**

```
localStorage["executor_accounts"] = JSON.stringify({
  "user_abc123": {
    email: "rhys@company.com",
    name: "Rhys",
    signedInAt: 1707400000,
  },
  "user_def456": {
    email: "rhys@personal.dev",
    name: "Rhys (personal)",
    signedInAt: 1707400100,
  },
})
localStorage["executor_active_account"] = "user_abc123"
localStorage["executor_active_workspace"] = "<workspace convex id>"
```

**Sign-in flow:**

1. User clicks "Sign in" (or "Add account" if already signed in)
2. Redirected to WorkOS AuthKit hosted UI
3. Callback returns with auth code → exchanged for JWT
4. Account entry added to localStorage map (existing entries preserved)
5. Convex provider uses **active account's token** for auth

**Account switching:**

- Sidebar shows all signed-in accounts
- Clicking one sets `executor_active_account` and swaps the Convex auth token
- Workspace picker shows workspaces the active account has users in

**Sign-out:**

- "Sign out" removes one account entry
- "Sign out of all" clears the map
- Auto-switch to next account if active was removed

---

## WorkOS Webhook → Convex Sync

The `@convex-dev/workos-authkit` component handles webhook verification.
We subscribe to these events and map them to our three tables:

### User events → accounts table

| Event | Handler |
|---|---|
| `user.created` | Insert `accounts` row. Create a personal workspace + user (owner). |
| `user.updated` | Patch `accounts` row (email, name, avatar). |
| `user.deleted` | Delete `accounts` row. Delete all `users` for that account. Optionally delete orphaned personal workspaces. |

### Organization events → workspaces table

| Event | Handler |
|---|---|
| `organization.created` | Insert `workspaces` row with `workosOrgId`. |
| `organization.updated` | Patch `workspaces` name. |
| `organization.deleted` | Delete `workspaces` row. Delete all `users` in that workspace. |

### Organization membership events → users table

| Event | Handler |
|---|---|
| `organization_membership.created` | Look up account (by `user_id`) and workspace (by `organization_id`). Insert `users` row. |
| `organization_membership.updated` | Patch role/status on `users` row. |
| `organization_membership.deleted` | Delete `users` row. |

---

## Convex Setup

WorkOS component can be registered unconditionally, but webhook/event handling
and JWT validation are only active when WorkOS creds exist. Guest auth helpers
remain active in all environments.

### New files

```
executor/
  convex/
    convex.config.ts     ← register @convex-dev/workos-authkit component
    auth.config.ts       ← JWT validation (empty providers in anonymous mode)
    auth.ts              ← anonymous bootstrap + WorkOS webhook handlers + queries
    http.ts              ← HTTP router for webhook endpoint
    lib/
      auth-helpers.ts    ← resolveAccount(), requireUser(), requireRole()
```

### convex.config.ts

```ts
import { defineApp } from "convex/server";
import workOSAuthKit from "@convex-dev/workos-authkit/convex.config";

const app = defineApp();
app.use(workOSAuthKit);
export default app;
```

### auth.config.ts

Conditional: only configures JWT providers when `WORKOS_CLIENT_ID` is set.
Without it, Convex has no auth providers — all requests are unauthenticated,
which is correct for anonymous mode.

```ts
const clientId = process.env.WORKOS_CLIENT_ID;

const authConfig = clientId
  ? {
      providers: [
        {
          type: "customJwt" as const,
          issuer: "https://api.workos.com/",
          algorithm: "RS256" as const,
          applicationID: clientId,
          jwks: `https://api.workos.com/sso/jwks/${clientId}`,
        },
        {
          type: "customJwt" as const,
          issuer: `https://api.workos.com/user_management/${clientId}`,
          algorithm: "RS256" as const,
          jwks: `https://api.workos.com/sso/jwks/${clientId}`,
        },
      ],
    }
  : { providers: [] };

export default authConfig;
```

### auth.ts

Contains: anonymous bootstrap mutation, WorkOS webhook handlers, dual-path queries.

```ts
import { query, mutation } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { AuthKit, type AuthFunctions } from "@convex-dev/workos-authkit";
import type { DataModel } from "./_generated/dataModel";
import { v } from "convex/values";
import { resolveAccount } from "./lib/auth-helpers";

const authFunctions: AuthFunctions = internal.auth;

export const authKit = new AuthKit<DataModel>(components.workOSAuthKit, {
  authFunctions,
  additionalEventTypes: [
    "organization.created",
    "organization.updated",
    "organization.deleted",
    "organization_membership.created",
    "organization_membership.updated",
    "organization_membership.deleted",
  ],
});

// ─────────────────────────────────────────────────────────────
// Anonymous guest bootstrap (idempotent)
// ─────────────────────────────────────────────────────────────

export const bootstrapAnonymousSession = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("accounts")
      .withIndex("by_provider", (q) =>
        q.eq("provider", "anonymous").eq("providerAccountId", "guest-default")
      )
      .unique();

    if (existing) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_account", (q) => q.eq("accountId", existing._id))
        .first();
      if (!user) throw new Error("Anonymous user record missing");
      return {
        accountId: existing._id,
        workspaceId: user.workspaceId,
        userId: user._id,
      };
    }

    const accountId = await ctx.db.insert("accounts", {
      provider: "anonymous",
      providerAccountId: "guest-default",
      email: "guest@executor.local",
      name: "Guest User",
      createdAt: now,
      updatedAt: now,
    });

    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "guest",
      name: "Guest Workspace",
      plan: "free",
      createdAt: now,
      updatedAt: now,
    });

    const userId = await ctx.db.insert("users", {
      accountId,
      workspaceId,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return { accountId, workspaceId, userId };
  },
});

// ─────────────────────────────────────────────────────────────
// WorkOS webhooks (only fire when webhooks are configured)
// ─────────────────────────────────────────────────────────────

export const { authKitEvent } = authKit.events({
  "user.created": async (ctx, event) => {
    const now = Date.now();
    const d = event.data;
    const accountId = await ctx.db.insert("accounts", {
      provider: "workos",
      providerAccountId: d.id,
      email: d.email,
      name: [d.firstName, d.lastName].filter(Boolean).join(" ") || d.email,
      firstName: d.firstName ?? undefined,
      lastName: d.lastName ?? undefined,
      avatarUrl: d.profilePictureUrl ?? undefined,
      createdAt: now,
      updatedAt: now,
    });

    // Personal workspace
    const slug = d.email.split("@")[0].replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const wsId = await ctx.db.insert("workspaces", {
      slug: `${slug}-${d.id.slice(-6)}`,
      name: `${d.firstName ?? slug}'s workspace`,
      plan: "free",
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("users", {
      accountId,
      workspaceId: wsId,
      role: "owner",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  },

  "user.updated": async (ctx, event) => {
    const d = event.data;
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_provider", (q) =>
        q.eq("provider", "workos").eq("providerAccountId", d.id)
      )
      .unique();
    if (!account) return;
    await ctx.db.patch(account._id, {
      email: d.email,
      name: [d.firstName, d.lastName].filter(Boolean).join(" ") || d.email,
      firstName: d.firstName ?? undefined,
      lastName: d.lastName ?? undefined,
      avatarUrl: d.profilePictureUrl ?? undefined,
      updatedAt: Date.now(),
    });
  },

  "user.deleted": async (ctx, event) => {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_provider", (q) =>
        q.eq("provider", "workos").eq("providerAccountId", event.data.id)
      )
      .unique();
    if (!account) return;
    const users = await ctx.db
      .query("users")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();
    for (const u of users) await ctx.db.delete(u._id);
    await ctx.db.delete(account._id);
  },

  "organization.created": async (ctx, event) => {
    const now = Date.now();
    const d = event.data;
    const slug = d.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    await ctx.db.insert("workspaces", {
      workosOrgId: d.id,
      slug: `${slug}-${d.id.slice(-6)}`,
      name: d.name,
      plan: "free",
      createdAt: now,
      updatedAt: now,
    });
  },

  "organization.updated": async (ctx, event) => {
    const ws = await ctx.db
      .query("workspaces")
      .withIndex("by_workos_org_id", (q) => q.eq("workosOrgId", event.data.id))
      .unique();
    if (!ws) return;
    await ctx.db.patch(ws._id, { name: event.data.name, updatedAt: Date.now() });
  },

  "organization.deleted": async (ctx, event) => {
    const ws = await ctx.db
      .query("workspaces")
      .withIndex("by_workos_org_id", (q) => q.eq("workosOrgId", event.data.id))
      .unique();
    if (!ws) return;
    const users = await ctx.db
      .query("users")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", ws._id))
      .collect();
    for (const u of users) await ctx.db.delete(u._id);
    await ctx.db.delete(ws._id);
  },

  "organization_membership.created": async (ctx, event) => {
    const now = Date.now();
    const d = event.data;
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_provider", (q) =>
        q.eq("provider", "workos").eq("providerAccountId", d.user_id)
      )
      .unique();
    const ws = await ctx.db
      .query("workspaces")
      .withIndex("by_workos_org_id", (q) => q.eq("workosOrgId", d.organization_id))
      .unique();
    if (!account || !ws) return;

    const existing = await ctx.db
      .query("users")
      .withIndex("by_account_workspace", (q) =>
        q.eq("accountId", account._id).eq("workspaceId", ws._id)
      )
      .unique();
    if (existing) return;

    const workosRole = d.role?.slug ?? "member";
    await ctx.db.insert("users", {
      accountId: account._id,
      workspaceId: ws._id,
      workosOrgMembershipId: d.id,
      role: workosRole === "admin" ? "admin" : "member",
      status: d.status === "active" ? "active" : "pending",
      createdAt: now,
      updatedAt: now,
    });
  },

  "organization_membership.updated": async (ctx, event) => {
    const d = event.data;
    const user = await ctx.db
      .query("users")
      .withIndex("by_workos_membership_id", (q) =>
        q.eq("workosOrgMembershipId", d.id)
      )
      .unique();
    if (!user) return;
    const workosRole = d.role?.slug ?? "member";
    await ctx.db.patch(user._id, {
      role: workosRole === "admin" ? "admin" : "member",
      status: d.status === "active" ? "active" : "pending",
      updatedAt: Date.now(),
    });
  },

  "organization_membership.deleted": async (ctx, event) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_workos_membership_id", (q) =>
        q.eq("workosOrgMembershipId", event.data.id)
      )
      .unique();
    if (!user) return;
    await ctx.db.delete(user._id);
  },
});

// ─────────────────────────────────────────────────────────────
// Queries (work in both modes via resolveAccount)
// ─────────────────────────────────────────────────────────────

export const getCurrentAccount = query({
  args: {},
  handler: async (ctx) => resolveAccount(ctx),
});

export const getMyWorkspaces = query({
  args: {},
  handler: async (ctx) => {
    const account = await resolveAccount(ctx);
    if (!account) return [];
    const memberships = await ctx.db
      .query("users")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();
    const results = await Promise.all(
      memberships
        .filter((u) => u.status === "active")
        .map(async (u) => {
          const ws = await ctx.db.get(u.workspaceId);
          return ws ? { ...ws, role: u.role, userId: u._id } : null;
        })
    );
    return results.filter(Boolean);
  },
});

export const getWorkspaceMembers = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const members = await ctx.db
      .query("users")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return Promise.all(
      members.map(async (u) => {
        const account = await ctx.db.get(u.accountId);
        return {
          userId: u._id,
          role: u.role,
          status: u.status,
          email: account?.email,
          name: account?.name,
          avatarUrl: account?.avatarUrl,
        };
      })
    );
  },
});
```

### http.ts

```ts
import { httpRouter } from "convex/server";
import { authKit } from "./auth";

const http = httpRouter();
authKit.registerRoutes(http);
export default http;
```

### lib/auth-helpers.ts

The key abstraction. Works transparently across both paths:
- **Authenticated path**: JWT present -> look up account by `provider=workos`
- **Guest path**: no JWT present -> resolve anonymous account from
  guest session context

```ts
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id, Doc } from "../_generated/dataModel";

type Ctx = QueryCtx | MutationCtx;

/**
 * Resolve the current caller to an account.
 *
 * Authenticated path: JWT present -> look up by provider subject.
 * Guest path: no JWT -> return account linked to guest session.
 */
export async function resolveAccount(ctx: Ctx): Promise<Doc<"accounts"> | null> {
  const identity = await ctx.auth.getUserIdentity();

  if (identity) {
    // Authenticated path: JWT present
    return ctx.db
      .query("accounts")
      .withIndex("by_provider", (q) =>
        q.eq("provider", "workos").eq("providerAccountId", identity.subject)
      )
      .unique();
  }

  // Guest path: no JWT, resolve from guest session id/cookie
  // (implementation detail: read anonymous session row, then fetch account)
  const guest = await resolveGuestSession(ctx);
  if (!guest) return null;
  return await ctx.db.get(guest.accountId);
}

/**
 * Resolve account + verify membership in workspace.
 */
export async function requireUser(ctx: Ctx, workspaceId: Id<"workspaces">) {
  const account = await resolveAccount(ctx);
  if (!account) throw new Error("Not authenticated");

  const user = await ctx.db
    .query("users")
    .withIndex("by_account_workspace", (q) =>
      q.eq("accountId", account._id).eq("workspaceId", workspaceId)
    )
    .unique();
  if (!user || user.status !== "active") {
    throw new Error("Not a member of this workspace");
  }

  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) throw new Error("Workspace not found");

  return { account, user, workspace };
}

const ROLE_RANK: Record<string, number> = { owner: 3, admin: 2, member: 1 };

export async function requireRole(
  ctx: Ctx,
  workspaceId: Id<"workspaces">,
  minRole: "member" | "admin" | "owner"
) {
  const result = await requireUser(ctx, workspaceId);
  const actual = ROLE_RANK[result.user.role] ?? 0;
  const required = ROLE_RANK[minRole] ?? 0;
  if (actual < required) {
    throw new Error(`Requires ${minRole} role, you are ${result.user.role}`);
  }
  return result;
}
```

---

## Next.js Frontend

### Capability detection

```ts
// src/lib/auth-capabilities.ts
export const workosEnabled = !!process.env.NEXT_PUBLIC_WORKOS_CLIENT_ID;
export const anonymousDemoEnabled = process.env.NEXT_PUBLIC_EXECUTOR_ALLOW_ANON_DEMO !== "0";
```

### Provider (`src/lib/convex-provider.tsx` — rewritten)

Uses `ConvexProviderWithAuth` only when WorkOS is enabled; otherwise plain
`ConvexProvider`. Guest sessions remain available in both cases.

```tsx
"use client";

import { ReactNode } from "react";
import { ConvexProvider, ConvexReactClient, ConvexProviderWithAuth } from "convex/react";
import { workosEnabled } from "./auth-capabilities";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? "http://127.0.0.1:3210";
const convex = new ConvexReactClient(convexUrl, { unsavedChangesWarning: false });

export function AppConvexProvider({ children }: { children: ReactNode }) {
  if (workosEnabled) {
    return <WorkOSProvider>{children}</WorkOSProvider>;
  }
  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}

function WorkOSProvider({ children }: { children: ReactNode }) {
  // These imports are safe because this branch only runs when
  // NEXT_PUBLIC_WORKOS_CLIENT_ID is set (packages are installed)
  const { AuthKitProvider, useAuth, useAccessToken } =
    require("@workos-inc/authkit-nextjs/components");

  function useAuthFromAuthKit() {
    const { user, loading } = useAuth();
    const { accessToken, loading: tokenLoading, error: tokenError } = useAccessToken();
    return {
      isLoading: (loading ?? false) || (tokenLoading ?? false),
      isAuthenticated: !!user && !!accessToken && !tokenError,
      fetchAccessToken: async () => accessToken ?? null,
    };
  }

  return (
    <AuthKitProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useAuthFromAuthKit}>
        {children}
      </ConvexProviderWithAuth>
    </AuthKitProvider>
  );
}
```

### Session context (`src/lib/session-context.tsx` — rewritten)

Unified interface for guest and authenticated paths. Same shape; source differs.

```tsx
"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { workosEnabled, anonymousDemoEnabled } from "./auth-capabilities";
import type { Id } from "../../convex/_generated/dataModel";

interface SessionState {
  accountId: Id<"accounts"> | null;
  workspaceId: Id<"workspaces"> | null;
  userId: Id<"users"> | null;
  workspaces: Array<{ _id: Id<"workspaces">; name: string; slug: string; role: string }>;
  loading: boolean;
  mode: "guest" | "workos";
  switchWorkspace: (id: Id<"workspaces">) => void;
}

const SessionContext = createContext<SessionState>(/* defaults */);

export function SessionProvider({ children }: { children: ReactNode }) {
  if (!workosEnabled) return <GuestSessionProvider>{children}</GuestSessionProvider>;
  return <HybridSessionProvider>{children}</HybridSessionProvider>;
}

// ── Guest path: call bootstrapAnonymousSession, done ──────
function GuestSessionProvider({ children }: { children: ReactNode }) {
  const bootstrap = useMutation(api.auth.bootstrapAnonymousSession);
  const [session, setSession] = useState<{ ... } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    bootstrap({}).then(setSession).finally(() => setLoading(false));
  }, [bootstrap]);

  return (
    <SessionContext.Provider value={{
      accountId: session?.accountId ?? null,
      workspaceId: session?.workspaceId ?? null,
      userId: session?.userId ?? null,
      workspaces: session ? [{ _id: session.workspaceId, name: "Guest Workspace", slug: "guest", role: "owner" }] : [],
      loading,
      mode: "guest",
      switchWorkspace: () => {},
    }}>
      {children}
    </SessionContext.Provider>
  );
}

// ── Hybrid path: if signed in use WorkOS, otherwise guest ──
function HybridSessionProvider({ children }: { children: ReactNode }) {
  const account = useQuery(api.auth.getCurrentAccount);
  if (account === null && anonymousDemoEnabled) {
    return <GuestSessionProvider>{children}</GuestSessionProvider>;
  }
  const workspaces = useQuery(api.auth.getMyWorkspaces) ?? [];
  const [activeWsId, setActiveWsId] = useState<Id<"workspaces"> | null>(null);

  const workspaceId = activeWsId ?? workspaces[0]?._id ?? null;
  const activeWs = workspaces.find((w) => w._id === workspaceId);

  return (
    <SessionContext.Provider value={{
      accountId: account?._id ?? null,
      workspaceId,
      userId: activeWs?.userId ?? null,
      workspaces,
      loading: account === undefined,
      mode: "workos",
      switchWorkspace: setActiveWsId,
    }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}
```

### Layout (`layout.tsx`)

Same structure as today — just the providers underneath do the branching:

```tsx
<AppConvexProvider>     {/* plain ConvexProvider or ConvexProviderWithAuth */}
  <SessionProvider>     {/* GuestSessionProvider or WorkOSSessionProvider */}
    {children}
  </SessionProvider>
</AppConvexProvider>
```

### Middleware (`apps/web/middleware.ts`)

Enabled only when WorkOS is configured, but always leaves guest/demo paths unauthenticated:

```ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export default async function middleware(request: NextRequest) {
  if (!process.env.WORKOS_CLIENT_ID) return NextResponse.next();

  const { authkitMiddleware } = await import("@workos-inc/authkit-nextjs");
  return authkitMiddleware({
    middlewareAuth: {
      enabled: true,
      unauthenticatedPaths: ["/", "/sign-in", "/sign-up"],
    },
  })(request);
}
```

### Auth routes

These routes are used when user chooses "Sign in". Guest/demo users never need
to hit them.

**`src/app/callback/route.ts`** — `handleAuth()` from authkit-nextjs
**`src/app/sign-in/route.ts`** — redirect to `getSignInUrl()`
**`src/app/sign-up/route.ts`** — redirect to `getSignUpUrl()`

### Multi-account store (`src/lib/account-store.ts`)

Only used in WorkOS mode. Manages localStorage map of signed-in accounts:

```ts
interface StoredAccount {
  workosUserId: string;
  email: string;
  name: string;
  signedInAt: number;
}

// CRUD for the accounts map + active account/workspace getters/setters
```

### Sidebar (`app-shell.tsx`)

`SessionInfo` branches on `mode`:
- **Guest mode**: green dot + "Guest Demo" label + "Sign in" CTA
- **WorkOS mode**: account avatar, workspace picker dropdown, "Add account" button

---

## Migration: Existing Anonymous Sessions

### Transition period

- Keep `anonymousSessions` table and `bootstrapAnonymousSession` working
  alongside the new tables
- New code paths use `bootstrapAnonymousSession` (guest) or WorkOS auth
- Existing domain tables (`tasks`, `approvals`, etc.) keep their
  string-based `workspaceId` / `actorId` unchanged
- Add `legacyWorkspaceId: v.optional(v.string())` to `workspaces` table
  to bridge old `ws_<uuid>` strings → new Convex IDs

### Cleanup (later)

- Keep anonymous guest support in hosted and local deployments (demo path)
- Migrate domain tables to use `v.id("workspaces")`

---

## Environment Variables

### Common

```bash
NEXT_PUBLIC_EXECUTOR_ALLOW_ANON_DEMO=1 # default on; keep for hosted demos
```

### Anonymous mode (zero config)

Nothing auth-related needed. Just:

```bash
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210
```

### WorkOS mode

**Convex deployment:**
```bash
bunx convex env set WORKOS_CLIENT_ID=client_...
bunx convex env set WORKOS_WEBHOOK_SECRET=whsec_...
```

**Next.js `.env.local`:**
```bash
NEXT_PUBLIC_WORKOS_CLIENT_ID=client_...
WORKOS_CLIENT_ID=client_...
WORKOS_API_KEY=sk_test_...
WORKOS_COOKIE_PASSWORD=<32+ char random string>
NEXT_PUBLIC_WORKOS_REDIRECT_URI=http://localhost:3000/callback
NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210
```

WorkOS mode still supports guest/demo entry unless
`NEXT_PUBLIC_EXECUTOR_ALLOW_ANON_DEMO=0`.

### WorkOS Dashboard

1. Enable AuthKit
2. Set redirect URI: `http://localhost:3000/callback`
3. Configure CORS: `http://localhost:3000`
4. Create webhook endpoint: `https://<deployment>.convex.site/workos/webhook`
5. Subscribe to events:
   - `user.created`, `user.updated`, `user.deleted`
   - `organization.created`, `organization.updated`, `organization.deleted`
   - `organization_membership.created`, `organization_membership.updated`, `organization_membership.deleted`

---

## Packages to Install

```bash
# executor root (convex functions)
bun add @convex-dev/workos-authkit

# executor/apps/web (Next.js)
bun add @workos-inc/authkit-nextjs @convex-dev/workos
```

---

## Files Summary

### New

| File | What |
|---|---|
| `convex/convex.config.ts` | Register WorkOS AuthKit component |
| `convex/auth.config.ts` | Conditional JWT validation (when WorkOS enabled) |
| `convex/auth.ts` | Guest bootstrap + WorkOS webhooks + dual-path queries |
| `convex/http.ts` | HTTP router for webhook endpoint |
| `convex/lib/auth-helpers.ts` | `resolveAccount()`, `requireUser()`, `requireRole()` — guest + auth |
| `apps/web/middleware.ts` | AuthKit when enabled; guest/demo always allowed |
| `apps/web/src/app/callback/route.ts` | OAuth callback |
| `apps/web/src/app/sign-in/route.ts` | Sign-in redirect |
| `apps/web/src/app/sign-up/route.ts` | Sign-up redirect |
| `apps/web/src/lib/auth-capabilities.ts` | `workosEnabled` and guest-demo flags |
| `apps/web/src/lib/account-store.ts` | Multi-account localStorage (WorkOS only) |

### Modified

| File | What |
|---|---|
| `convex/schema.ts` | Add `accounts`, `workspaces`, `users` tables |
| `apps/web/src/lib/convex-provider.tsx` | Branch on auth mode |
| `apps/web/src/lib/session-context.tsx` | Rewrite: `GuestSessionProvider` / `HybridSessionProvider` |
| `apps/web/src/components/app-shell.tsx` | Dual-mode sidebar |
| `apps/web/package.json` | Add WorkOS deps (optional, only needed in WorkOS mode) |
| `executor/package.json` | Add `@convex-dev/workos-authkit` |

### Preserved

| File | Why |
|---|---|
| `convex/schema.ts` → `anonymousSessions` table | Keep hosted/local demo path |
| `convex/database.ts` → `bootstrapAnonymousSession` | Keep guest bootstrap compatibility |

---

## Rollout Order

1. **Schema** — add `accounts`, `workspaces`, `users` tables. No behavior change.
2. **Backend plumbing** — `convex.config.ts`, `auth.config.ts`, `http.ts`, `auth-helpers.ts`.
3. **Guest bootstrap** — `bootstrapAnonymousSession` mutation in `auth.ts`.
4. **Rewrite session context** — guest + authenticated hybrid provider.
5. **Test guest mode** — works in local and hosted deployments.
6. **WorkOS webhook handlers** — event handlers in `auth.ts`. Configure WorkOS dashboard.
7. **Next.js auth routes** — middleware, callback, sign-in, sign-up.
8. **WorkOS provider branch** — `ConvexProviderWithAuth` in `convex-provider.tsx`.
9. **Multi-account UI** — account store, account/workspace switcher in sidebar.
10. **Auth enforcement** — add `requireUser()` checks to existing Convex functions.
11. **Cleanup** — keep anonymous demo path; remove only dead compatibility code.
