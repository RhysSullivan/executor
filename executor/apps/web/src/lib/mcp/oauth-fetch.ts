import { parseMcpSourceUrl } from "@/lib/mcp/oauth-url";

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

function toUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  return new URL(input.url);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError";
}

async function fetchWithRequestTimeout(
  input: URL,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const sourceSignal = init.signal;
  const abortFromSourceSignal = () => controller.abort();
  if (sourceSignal) {
    if (sourceSignal.aborted) {
      controller.abort();
    } else {
      sourceSignal.addEventListener("abort", abortFromSourceSignal, { once: true });
    }
  }

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      redirect: "manual",
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    sourceSignal?.removeEventListener("abort", abortFromSourceSignal);
  }
}

export async function fetchMcpOAuth(
  input: RequestInfo | URL,
  init: RequestInit,
  options: {
    timeoutMs: number;
    label: string;
    maxRedirects?: number;
  },
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = toUrl(input);
  let currentInit = { ...init };

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetchWithRequestTimeout(currentUrl, currentInit, options.timeoutMs, options.label);

    if (!REDIRECT_STATUS_CODES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location")?.trim() ?? "";
    if (!location) {
      return response;
    }

    await response.body?.cancel();

    if (redirectCount === maxRedirects) {
      throw new Error(`Too many redirects while ${options.label.toLowerCase()}`);
    }

    const nextUrlRaw = new URL(location, currentUrl).toString();
    const nextUrlResult = parseMcpSourceUrl(nextUrlRaw);
    if (!nextUrlResult.isOk()) {
      throw new Error(`OAuth request redirected to an invalid URL: ${nextUrlRaw}`);
    }
    currentUrl = nextUrlResult.value;

    const method = (currentInit.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      currentInit = {
        ...currentInit,
        method: "GET",
        body: undefined,
      };
    }
  }

  throw new Error(`Too many redirects while ${options.label.toLowerCase()}`);
}
