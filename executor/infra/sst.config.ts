/// <reference path="./.sst/platform/config.d.ts" />

function toSiteUrl(convexUrl: string): string {
  if (convexUrl.includes(".convex.cloud")) {
    return convexUrl.replace(".convex.cloud", ".convex.site");
  }
  return convexUrl;
}

function compact<T>(values: Array<T | null | undefined>): T[] {
  return values.filter((value): value is T => value !== null && value !== undefined);
}

function parseConvexEnvList(raw: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1);
    if (key.length > 0) {
      env.set(key, value);
    }
  }
  return env;
}

function loadConvexEnv(executorRoot: string, spawnSync: any): Map<string, string> {
  if (process.env.IAC_USE_CONVEX_ENV_DISCOVERY === "0") {
    return new Map<string, string>();
  }

  const listed = spawnSync("bunx", ["convex", "env", "list", "--prod"], {
    cwd: executorRoot,
    env: process.env,
    encoding: "utf8",
  });

  if (listed.status !== 0) {
    return new Map<string, string>();
  }

  return parseConvexEnvList(listed.stdout ?? "");
}

function createResolver(config: any, pulumi: any, convexEnv: Map<string, string>) {
  const readText = (configKey: string, envKey: string): string | undefined => {
    const cfg = config.get(configKey);
    if (cfg && cfg.trim().length > 0) {
      return cfg.trim();
    }

    const env = process.env[envKey];
    if (env && env.trim().length > 0) {
      return env.trim();
    }

    const discovered = convexEnv.get(envKey);
    if (discovered && discovered.trim().length > 0) {
      return discovered.trim();
    }

    return undefined;
  };

  const readSecret = (configKey: string, envKey: string): any => {
    const cfg = config.getSecret(configKey);
    if (cfg) {
      return cfg;
    }

    const text = readText(configKey, envKey);
    return text ? pulumi.secret(text) : undefined;
  };

  const requireText = (configKey: string, envKey: string): string => {
    const value = readText(configKey, envKey);
    if (!value) {
      throw new Error(`Missing required value '${configKey}' (or env '${envKey}')`);
    }
    return value;
  };

  const requireSecret = (configKey: string, envKey: string): any => {
    const value = readSecret(configKey, envKey);
    if (!value) {
      throw new Error(`Missing required secret '${configKey}' (or env '${envKey}')`);
    }
    return value;
  };

  const readBool = (configKey: string, envKey: string, fallback: boolean): boolean => {
    const cfg = config.getBoolean(configKey);
    if (cfg !== undefined) {
      return cfg;
    }

    const env = process.env[envKey]?.trim().toLowerCase();
    if (!env) {
      return fallback;
    }

    if (["1", "true", "yes", "on"].includes(env)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(env)) {
      return false;
    }
    return fallback;
  };

  return {
    readText,
    readSecret,
    requireText,
    requireSecret,
    readBool,
  };
}

function setupStripe(args: {
  manageStripeCatalog: boolean;
  resolver: ReturnType<typeof createResolver>;
  stripe: any;
  config: any;
  stage: string;
  convexSiteUrl: string;
}) {
  const { manageStripeCatalog, resolver, stripe, config, stage, convexSiteUrl } = args;

  let stripePriceId: any = resolver.readText("stripePriceId", "STRIPE_PRICE_ID");
  let stripeWebhookSecret: any = resolver.readSecret("stripeWebhookSecret", "STRIPE_WEBHOOK_SECRET");
  const stripeSecretKey = resolver.readSecret("stripeSecretKey", "STRIPE_SECRET_KEY");

  let stripeProductResource: any;
  if (manageStripeCatalog) {
    const stripeProvider = new stripe.Provider("stripe-provider", {
      apiKey: resolver.requireSecret("stripeSecretKey", "STRIPE_SECRET_KEY"),
    });

    const unitAmountRaw = resolver.requireText("stripeUnitAmount", "IAC_STRIPE_UNIT_AMOUNT");
    const unitAmount = Number.parseInt(unitAmountRaw, 10);
    if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
      throw new Error(`Invalid stripeUnitAmount '${unitAmountRaw}'`);
    }

    const currency = resolver.readText("stripeCurrency", "IAC_STRIPE_CURRENCY") ?? "usd";
    const interval = resolver.readText("stripeInterval", "IAC_STRIPE_INTERVAL") ?? "month";
    const lookupKey = resolver.readText("stripeLookupKey", "IAC_STRIPE_LOOKUP_KEY") ?? "executor_team_seat_monthly";
    const productName = resolver.readText("stripeProductName", "IAC_STRIPE_PRODUCT_NAME") ?? "Executor Team Seat";
    const productDescription =
      resolver.readText("stripeProductDescription", "IAC_STRIPE_PRODUCT_DESCRIPTION")
      ?? "Per-seat subscription for Executor organizations.";

    stripeProductResource = new stripe.Product(
      "executor-seat-product",
      {
        name: productName,
        description: productDescription,
        active: true,
        metadata: { managedBy: "sst", stage },
      },
      { provider: stripeProvider },
    );

    const stripePrice = new stripe.Price(
      "executor-seat-price",
      {
        product: stripeProductResource.id,
        currency,
        unitAmount,
        lookupKey,
        recurring: { interval },
        metadata: { managedBy: "sst", stage },
      },
      { provider: stripeProvider },
    );
    stripePriceId = stripePrice.id;

    const webhookUrl = resolver.readText("stripeWebhookUrl", "IAC_STRIPE_WEBHOOK_URL") ?? `${convexSiteUrl}/stripe/webhook`;
    const webhookEvents =
      (config.getObject("stripeWebhookEvents") as string[] | undefined)
      ?? [
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "invoice.paid",
        "invoice.payment_failed",
      ];

    const webhook = new stripe.WebhookEndpoint(
      "executor-billing-webhook",
      {
        url: webhookUrl,
        enabledEvents: webhookEvents,
        description: `Executor billing webhook (${stage})`,
      },
      { provider: stripeProvider },
    );

    stripeWebhookSecret = webhook.secret;
  }

  return {
    stripePriceId,
    stripeWebhookSecret,
    stripeSecretKey,
    stripeProductResource,
  };
}

function setupCloudflareRuntime(args: {
  enabled: boolean;
  resolver: ReturnType<typeof createResolver>;
  pulumi: any;
  command: any;
  convexUrl: string;
  executorRoot: string;
}) {
  const { enabled, resolver, pulumi, command, convexUrl, executorRoot } = args;
  if (!enabled) {
    return undefined;
  }

  const runUrl = resolver.readText("cloudflareSandboxRunUrl", "CLOUDFLARE_SANDBOX_RUN_URL");
  const authToken = resolver.readSecret("cloudflareSandboxAuthToken", "CLOUDFLARE_SANDBOX_AUTH_TOKEN");
  const internalToken = resolver.readSecret("executorInternalToken", "EXECUTOR_INTERNAL_TOKEN");

  const runUrlArg = runUrl ? pulumi.interpolate` --run-url ${runUrl}` : "";
  const authArg = authToken ? pulumi.interpolate` --auth-token ${authToken}` : "";
  const internalArg = internalToken ? pulumi.interpolate` --internal-token ${internalToken}` : "";

  const setupCmd = pulumi.interpolate`bun run setup:prod:cloudflare --deploy --no-doctor --convex-url ${convexUrl}${runUrlArg}${authArg}${internalArg}`;

  return new command.local.Command("executor-cloudflare-runtime", {
    create: setupCmd,
    update: setupCmd,
    dir: executorRoot,
    triggers: [runUrl ?? "", convexUrl, authToken ?? "", internalToken ?? ""],
  });
}

function setupConvexEnvSync(args: {
  enabled: boolean;
  resolver: ReturnType<typeof createResolver>;
  command: any;
  executorRoot: string;
  cloudflareSetup: any;
  stripeSecretKey: any;
  stripeWebhookSecret: any;
  stripePriceId: any;
}) {
  const {
    enabled,
    resolver,
    command,
    executorRoot,
    cloudflareSetup,
    stripeSecretKey,
    stripeWebhookSecret,
    stripePriceId,
  } = args;
  if (!enabled) {
    return undefined;
  }

  const workosClientId = resolver.requireText("workosClientId", "WORKOS_CLIENT_ID");
  const workosApiKey = resolver.requireSecret("workosApiKey", "WORKOS_API_KEY");
  const workosWebhookSecret = resolver.requireSecret("workosWebhookSecret", "WORKOS_WEBHOOK_SECRET");
  const workosCookiePassword = resolver.requireSecret("workosCookiePassword", "WORKOS_COOKIE_PASSWORD");
  const mcpAuthorizationServer =
    resolver.readText("mcpAuthorizationServer", "MCP_AUTHORIZATION_SERVER")
    ?? resolver.readText("mcpAuthorizationServer", "MCP_AUTHORIZATION_SERVER_URL");
  if (!mcpAuthorizationServer) {
    throw new Error("Missing MCP authorization server (MCP_AUTHORIZATION_SERVER or MCP_AUTHORIZATION_SERVER_URL)");
  }

  if (!stripeSecretKey) {
    throw new Error("Missing stripeSecretKey (or STRIPE_SECRET_KEY)");
  }
  if (!stripePriceId) {
    throw new Error("Missing stripePriceId (or STRIPE_PRICE_ID)");
  }
  if (!stripeWebhookSecret) {
    throw new Error("Missing stripeWebhookSecret (or STRIPE_WEBHOOK_SECRET)");
  }

  const billingSuccessUrl = resolver.readText("billingSuccessUrl", "BILLING_SUCCESS_URL");
  const billingCancelUrl = resolver.readText("billingCancelUrl", "BILLING_CANCEL_URL");
  const billingReturnUrl = resolver.readText("billingReturnUrl", "BILLING_RETURN_URL");

  const envVars: Record<string, any> = {
    WORKOS_CLIENT_ID: workosClientId,
    WORKOS_API_KEY: workosApiKey,
    WORKOS_WEBHOOK_SECRET: workosWebhookSecret,
    WORKOS_COOKIE_PASSWORD: workosCookiePassword,
    MCP_AUTHORIZATION_SERVER: mcpAuthorizationServer,
    STRIPE_SECRET_KEY: stripeSecretKey,
    STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
    STRIPE_PRICE_ID: stripePriceId,
  };

  if (billingSuccessUrl) envVars.BILLING_SUCCESS_URL = billingSuccessUrl;
  if (billingCancelUrl) envVars.BILLING_CANCEL_URL = billingCancelUrl;
  if (billingReturnUrl) envVars.BILLING_RETURN_URL = billingReturnUrl;

  return new command.local.Command(
    "executor-convex-env",
    {
      create: "bun run setup:prod:env --from-env --strict",
      update: "bun run setup:prod:env --from-env --strict",
      dir: executorRoot,
      environment: envVars,
      triggers: [
        workosClientId,
        workosApiKey,
        workosWebhookSecret,
        workosCookiePassword,
        mcpAuthorizationServer,
        stripeSecretKey,
        stripeWebhookSecret,
        stripePriceId,
        billingSuccessUrl ?? "",
        billingCancelUrl ?? "",
        billingReturnUrl ?? "",
      ],
    },
    {
      dependsOn: compact([cloudflareSetup]),
    },
  );
}

function setupConvexDeploy(args: {
  enabled: boolean;
  command: any;
  executorRoot: string;
  stage: string;
  convexEnvSync: any;
  cloudflareSetup: any;
}) {
  const { enabled, command, executorRoot, stage, convexEnvSync, cloudflareSetup } = args;
  if (!enabled) {
    return undefined;
  }

  return new command.local.Command(
    "executor-convex-deploy",
    {
      create: "bunx convex deploy --prod",
      update: "bunx convex deploy --prod",
      dir: executorRoot,
      triggers: [stage],
    },
    {
      dependsOn: compact([convexEnvSync, cloudflareSetup]),
    },
  );
}

function setupDoctor(args: {
  command: any;
  executorRoot: string;
  stage: string;
  convexDeploy: any;
  convexEnvSync: any;
  cloudflareSetup: any;
}) {
  const { command, executorRoot, stage, convexDeploy, convexEnvSync, cloudflareSetup } = args;
  return new command.local.Command(
    "executor-doctor-prod",
    {
      create: "bun run doctor:prod",
      update: "bun run doctor:prod",
      dir: executorRoot,
      triggers: [stage],
    },
    {
      dependsOn: compact([convexDeploy, convexEnvSync, cloudflareSetup]),
    },
  );
}

function setupVercel(args: {
  enabled: boolean;
  resolver: ReturnType<typeof createResolver>;
  vercel: any;
  convexUrl: string;
  convexSiteUrl: string;
  stripePriceId: any;
}) {
  const { enabled, resolver, vercel, convexUrl, convexSiteUrl, stripePriceId } = args;
  if (!enabled) {
    return undefined;
  }

  const vercelApiToken = resolver.requireSecret("vercelApiToken", "VERCEL_API_TOKEN");
  const vercelTeam = resolver.readText("vercelTeam", "VERCEL_TEAM");
  const vercelProjectName = resolver.readText("vercelProjectName", "VERCEL_PROJECT_NAME") ?? "executor-web";
  const vercelGitRepo = resolver.readText("vercelGitRepo", "VERCEL_GIT_REPO");

  const provider = new vercel.Provider("vercel-provider", {
    apiToken: vercelApiToken,
    team: vercelTeam,
  });

  const project = new vercel.Project(
    "executor-web-project",
    {
      name: vercelProjectName,
      framework: "nextjs",
      rootDirectory: "executor/apps/web",
      gitRepository: vercelGitRepo
        ? {
            type: "github",
            repo: vercelGitRepo,
          }
        : undefined,
    },
    { provider },
  );

  const workosClientId = resolver.readText("workosClientId", "WORKOS_CLIENT_ID") ?? "";
  const workosApiKey = resolver.readSecret("workosApiKey", "WORKOS_API_KEY") ?? "";
  const workosCookiePassword = resolver.readSecret("workosCookiePassword", "WORKOS_COOKIE_PASSWORD") ?? "";

  const vercelVars: Array<{ key: string; value: any; sensitive: boolean }> = [
    { key: "CONVEX_URL", value: convexUrl, sensitive: false },
    { key: "CONVEX_SITE_URL", value: convexSiteUrl, sensitive: false },
    { key: "WORKOS_CLIENT_ID", value: workosClientId, sensitive: false },
    { key: "WORKOS_API_KEY", value: workosApiKey, sensitive: true },
    { key: "WORKOS_COOKIE_PASSWORD", value: workosCookiePassword, sensitive: true },
    { key: "STRIPE_PRICE_ID", value: stripePriceId ?? "", sensitive: false },
  ];

  for (const item of vercelVars) {
    if (!item.value) {
      continue;
    }

    new vercel.ProjectEnvironmentVariable(
      `vercel-env-${item.key.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      {
        projectId: project.id,
        key: item.key,
        value: item.value,
        targets: ["production", "preview", "development"],
        sensitive: item.sensitive,
      },
      { provider },
    );
  }

  return project;
}

export default $config({
  app(input: any) {
    return {
      name: "executor-infra",
      home: "local",
      removal: input?.stage === "production" ? "retain" : "remove",
    };
  },
  async run() {
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { spawnSync } = await import("node:child_process");
    const pulumi = await import("@pulumi/pulumi");
    const command = await import("@pulumi/command");
    const stripe = await import("pulumi-stripe");
    const vercel = await import("@pulumiverse/vercel");

    const stage = $app.stage;
    const executorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const config = new pulumi.Config();
    const convexEnv = loadConvexEnv(executorRoot, spawnSync);
    const resolver = createResolver(config, pulumi, convexEnv);

    const flags = {
      manageCloudflareRuntime: resolver.readBool("manageCloudflareRuntime", "IAC_MANAGE_CLOUDFLARE_RUNTIME", true),
      manageConvexEnv: resolver.readBool("manageConvexEnv", "IAC_MANAGE_CONVEX_ENV", true),
      deployConvexFunctions: resolver.readBool("deployConvexFunctions", "IAC_DEPLOY_CONVEX_FUNCTIONS", true),
      manageStripeCatalog: resolver.readBool("manageStripeCatalog", "IAC_MANAGE_STRIPE_CATALOG", false),
      manageVercelProject: resolver.readBool("manageVercelProject", "IAC_MANAGE_VERCEL_PROJECT", false),
    };

    const convexUrl = resolver.requireText("convexUrl", "CONVEX_URL");
    const convexSiteUrl = resolver.readText("convexSiteUrl", "CONVEX_SITE_URL") ?? toSiteUrl(convexUrl);

    const stripeState = setupStripe({
      manageStripeCatalog: flags.manageStripeCatalog,
      resolver,
      stripe,
      config,
      stage,
      convexSiteUrl,
    });

    const cloudflareSetup = setupCloudflareRuntime({
      enabled: flags.manageCloudflareRuntime,
      resolver,
      pulumi,
      command,
      convexUrl,
      executorRoot,
    });

    const convexEnvSync = setupConvexEnvSync({
      enabled: flags.manageConvexEnv,
      resolver,
      command,
      executorRoot,
      cloudflareSetup,
      stripeSecretKey: stripeState.stripeSecretKey,
      stripeWebhookSecret: stripeState.stripeWebhookSecret,
      stripePriceId: stripeState.stripePriceId,
    });

    const convexDeploy = setupConvexDeploy({
      enabled: flags.deployConvexFunctions,
      command,
      executorRoot,
      stage,
      convexEnvSync,
      cloudflareSetup,
    });

    const doctor = setupDoctor({
      command,
      executorRoot,
      stage,
      convexDeploy,
      convexEnvSync,
      cloudflareSetup,
    });

    const vercelProject = setupVercel({
      enabled: flags.manageVercelProject,
      resolver,
      vercel,
      convexUrl,
      convexSiteUrl,
      stripePriceId: stripeState.stripePriceId,
    });

    return {
      stage,
      convexUrl,
      convexSiteUrl,
      cloudflareRuntimeManaged: flags.manageCloudflareRuntime,
      convexEnvManaged: flags.manageConvexEnv,
      convexDeployManaged: flags.deployConvexFunctions,
      stripeManaged: flags.manageStripeCatalog,
      vercelManaged: flags.manageVercelProject,
      doctorCommand: "bun run --cwd executor doctor:prod",
      doctorResourceId: doctor.id,
      stripeProductId: stripeState.stripeProductResource?.id,
      stripePriceId: stripeState.stripePriceId,
      vercelProjectId: vercelProject?.id,
    };
  },
});
