export type ExecutorRuntimeConfig = {
  convexUrl?: string;
  convexSiteUrl?: string;
  workosClientId?: string;
  stripePriceId?: string;
  executorHttpUrl?: string;
  allowLocalVm?: boolean;
};

declare global {
  interface Window {
    __EXECUTOR_RUNTIME_CONFIG__?: ExecutorRuntimeConfig;
  }
}

function trim(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

function parseBooleanEnv(value: string | null | undefined): boolean | undefined {
  const candidate = trim(value);
  if (!candidate) {
    return undefined;
  }
  return TRUTHY_ENV_VALUES.has(candidate.toLowerCase());
}

function normalizeDeploymentSlug(value: string | undefined): string | undefined {
  const candidate = trim(value);
  if (!candidate) {
    return undefined;
  }

  const [, slug = candidate] = candidate.split(":", 2);
  const normalized = slug.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function convexCloudUrlFromDeployment(value: string | undefined): string | undefined {
  const slug = normalizeDeploymentSlug(value);
  return slug ? `https://${slug}.convex.cloud` : undefined;
}

function convexSiteUrlFromDeployment(value: string | undefined): string | undefined {
  const slug = normalizeDeploymentSlug(value);
  return slug ? `https://${slug}.convex.site` : undefined;
}

export function readRuntimeConfig(): ExecutorRuntimeConfig {
  if (typeof window !== "undefined" && window.__EXECUTOR_RUNTIME_CONFIG__) {
    return window.__EXECUTOR_RUNTIME_CONFIG__;
  }

  if (typeof window === "undefined") {
    return runtimeConfigFromEnv();
  }

  return {
    convexUrl: trim(import.meta.env.VITE_CONVEX_URL),
    convexSiteUrl: trim(import.meta.env.VITE_CONVEX_SITE_URL),
    workosClientId: trim(import.meta.env.VITE_WORKOS_CLIENT_ID),
    stripePriceId: trim(import.meta.env.VITE_STRIPE_PRICE_ID),
    executorHttpUrl: trim(import.meta.env.VITE_EXECUTOR_HTTP_URL),
    allowLocalVm: parseBooleanEnv(import.meta.env.VITE_DANGEROUSLY_ALLOW_LOCAL_VM),
  };
}

function toSiteUrl(convexUrl?: string): string | undefined {
  if (!convexUrl) {
    return undefined;
  }

  if (convexUrl.includes(".convex.cloud")) {
    return convexUrl.replace(".convex.cloud", ".convex.site");
  }

  return convexUrl;
}

export function runtimeConfigFromEnv(): ExecutorRuntimeConfig {
  const convexDeployment = trim(process.env.CONVEX_DEPLOYMENT ?? process.env.VITE_CONVEX_DEPLOYMENT);
  const convexUrl = trim(
    process.env.EXECUTOR_WEB_CONVEX_URL
      ?? process.env.CONVEX_URL
      ?? process.env.VITE_CONVEX_URL
      ?? convexCloudUrlFromDeployment(convexDeployment),
  );
  const convexSiteUrl = trim(
    process.env.EXECUTOR_WEB_CONVEX_SITE_URL
      ?? process.env.CONVEX_SITE_URL
      ?? process.env.VITE_CONVEX_SITE_URL
      ?? toSiteUrl(convexUrl)
      ?? convexSiteUrlFromDeployment(convexDeployment),
  );

  return {
    convexUrl,
    convexSiteUrl,
    workosClientId: trim(process.env.WORKOS_CLIENT_ID ?? process.env.VITE_WORKOS_CLIENT_ID),
    stripePriceId: trim(process.env.STRIPE_PRICE_ID ?? process.env.VITE_STRIPE_PRICE_ID),
    executorHttpUrl: trim(
      process.env.EXECUTOR_PUBLIC_ORIGIN
      ?? process.env.EXECUTOR_HTTP_URL
      ?? process.env.VITE_EXECUTOR_HTTP_URL,
    ),
    allowLocalVm: parseBooleanEnv(
      process.env.DANGEROUSLY_ALLOW_LOCAL_VM
      ?? process.env.VITE_DANGEROUSLY_ALLOW_LOCAL_VM,
    ),
  };
}
