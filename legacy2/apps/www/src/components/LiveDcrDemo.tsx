import { useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";

type OAuthCallbackMessage = {
  type: "executor:vercel-oauth-callback";
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
};

type VercelRegistrationResponse = {
  client_id: string;
};

type VercelTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  id_token?: string;
};

type VercelUserInfo = {
  sub: string;
  email: string;
  email_verified: boolean;
  preferred_username: string;
  picture?: string;
};

const REGISTER_URL = "https://api.vercel.com/login/oauth/register";
const AUTHORIZE_URL = "https://vercel.com/oauth/authorize";
const TOKEN_URL = "https://api.vercel.com/login/oauth/token";
const USERINFO_URL = "https://api.vercel.com/login/oauth/userinfo";

const LIVE_CODE = `const me = await tools.vercel.userinfo()

return {
  username: me.preferred_username,
  email: me.email,
  verified: me.email_verified,
  subject: me.sub,
}`;

function toBase64Url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toBase64Url(new Uint8Array(digest));
}

function normalizedLoopbackOrigin(current: URL): string {
  if (current.protocol === "http:" && current.hostname === "localhost") {
    return `http://127.0.0.1${current.port ? `:${current.port}` : ""}`;
  }
  return current.origin;
}

export function LiveDcrDemo() {
  const [code, setCode] = useState(LIVE_CODE);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Not connected");
  const [tokenScope, setTokenScope] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<VercelUserInfo | null>(null);
  const [output, setOutput] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const accessTokenRef = useRef<string | null>(null);

  const connected = Boolean(accessTokenRef.current);

  const handleEditorMount: OnMount = (_editor, monaco) => {
    monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
      target: monaco.languages.typescript.ScriptTarget.ESNext,
      module: monaco.languages.typescript.ModuleKind.ESNext,
      strict: true,
      noEmit: true,
      lib: ["esnext", "dom"],
    });

    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      `declare const tools: {
  vercel: {
    userinfo(): Promise<{
      sub: string
      email: string
      email_verified: boolean
      preferred_username: string
      picture?: string
    }>
  }
}`,
      "file:///types/executor-live-demo.d.ts",
    );
  };

  async function fetchUserInfo(token: string): Promise<VercelUserInfo> {
    const response = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error_description ?? payload?.error?.message ?? "Failed to fetch user info");
    }

    return payload as VercelUserInfo;
  }

  async function connectWithDcr() {
    setError(null);
    setOutput(null);
    setIsConnecting(true);

    try {
      const currentUrl = new URL(window.location.href);
      const callbackOrigin = normalizedLoopbackOrigin(currentUrl);
      const redirectUri = `${callbackOrigin}/callback`;

      setStatus("Registering OAuth client via DCR...");
      const registerResponse = await fetch(REGISTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: `executor-www-demo-${Math.random().toString(36).slice(2, 8)}`,
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });

      const registrationJson = (await registerResponse.json()) as
        | VercelRegistrationResponse
        | { error_description?: string };

      if (!registerResponse.ok || !("client_id" in registrationJson)) {
        throw new Error(
          (registrationJson as { error_description?: string }).error_description ??
            "Client registration failed",
        );
      }

      const clientId = registrationJson.client_id;
      const state = `executor_demo_${Math.random().toString(16).slice(2, 10)}`;
      const verifier = randomBase64Url(32);
      const challenge = await sha256Base64Url(verifier);

      const authUrl = new URL(AUTHORIZE_URL);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      const popup = window.open(authUrl.toString(), "executor-vercel-dcr", "width=560,height=760");
      if (!popup) {
        throw new Error("Popup blocked. Allow popups and try again.");
      }

      setStatus("Waiting for browser approval...");

      const callback = await new Promise<{ code: string; state: string }>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          cleanup();
          reject(new Error("OAuth callback timed out"));
        }, 5 * 60 * 1000);

        const pollClosed = window.setInterval(() => {
          if (popup.closed) {
            cleanup();
            reject(new Error("Login window closed before completion"));
          }
        }, 500);

        function cleanup() {
          window.clearTimeout(timeout);
          window.clearInterval(pollClosed);
          window.removeEventListener("message", onMessage);
        }

        function onMessage(event: MessageEvent) {
          const allowedOrigins = new Set([window.location.origin, callbackOrigin]);
          if (!allowedOrigins.has(event.origin)) return;
          const data = event.data as OAuthCallbackMessage | undefined;
          if (!data || data.type !== "executor:vercel-oauth-callback") return;

          cleanup();
          if (data.error) {
            reject(new Error(data.error_description ?? data.error));
            return;
          }

          if (!data.code || !data.state) {
            reject(new Error("Missing callback code/state"));
            return;
          }

          resolve({ code: data.code, state: data.state });
        }

        window.addEventListener("message", onMessage);
      });

      if (callback.state !== state) {
        throw new Error("State mismatch during OAuth callback");
      }

      setStatus("Exchanging code for token...");

      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code: callback.code,
        code_verifier: verifier,
      });

      const tokenResponse = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      });

      const tokenJson = (await tokenResponse.json()) as
        | VercelTokenResponse
        | { error_description?: string };

      if (!tokenResponse.ok || !("access_token" in tokenJson)) {
        throw new Error(
          (tokenJson as { error_description?: string }).error_description ??
            "Token exchange failed",
        );
      }

      accessTokenRef.current = tokenJson.access_token;
      setTokenScope(tokenJson.scope ?? null);

      setStatus("Calling userinfo endpoint...");
      const profile = await fetchUserInfo(tokenJson.access_token);
      setUserInfo(profile);
      setStatus("Connected: DCR + OAuth completed in-browser");
    } catch (connectError) {
      setStatus("Connection failed");
      setError(connectError instanceof Error ? connectError.message : "Unknown connection error");
    } finally {
      setIsConnecting(false);
    }
  }

  async function runEditorCode() {
    setError(null);
    setIsRunning(true);

    try {
      const token = accessTokenRef.current;
      if (!token) {
        throw new Error("Connect the demo first to get a bearer token");
      }

      const tools = {
        vercel: {
          userinfo: async () => fetchUserInfo(token),
        },
      };

      const run = new Function(
        "tools",
        `"use strict"; return (async () => {\n${code}\n})();`,
      ) as (value: typeof tools) => Promise<unknown>;

      const result = await run(tools);
      setOutput(result);
      setStatus("Executed code in browser sandbox");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Unknown execution error");
    } finally {
      setIsRunning(false);
    }
  }

  const outputText = useMemo(() => {
    if (output == null) return "";
    return JSON.stringify(output, null, 2);
  }, [output]);

  return (
    <div className="rounded-2xl border border-white/[0.1] bg-surface-elevated overflow-hidden">
      <div className="px-5 py-4 border-b border-white/[0.08] bg-white/[0.02] flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-serif text-xl text-[#f5f5f5] m-0">Live DCR Demo (Vercel OAuth)</h3>
          <p className="text-xs text-white/45 mt-1 mb-0">
            Browser-only flow: register client, authorize, exchange token, call API, then run code.
          </p>
        </div>
        <span
          className={`text-[0.65rem] uppercase tracking-[0.14em] px-2.5 py-1 rounded border ${
            connected ? "text-green-300 border-green-500/40 bg-green-500/10" : "text-white/45 border-white/20"
          }`}
        >
          {connected ? "Connected" : "Disconnected"}
        </span>
      </div>

      <div className="p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={connectWithDcr}
            disabled={isConnecting}
            className="px-3.5 py-2 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-60"
          >
            {isConnecting ? "Connecting..." : "Connect with DCR"}
          </button>
          <button
            type="button"
            onClick={runEditorCode}
            disabled={!connected || isRunning}
            className="px-3.5 py-2 rounded-md border border-white/20 text-white text-sm font-medium disabled:opacity-50"
          >
            {isRunning ? "Running..." : "Run in Monaco"}
          </button>
          <span className="text-xs text-white/45">{status}</span>
        </div>

        {tokenScope && (
          <p className="text-xs text-white/55 m-0">
            Token scope: <code>{tokenScope}</code>
          </p>
        )}

        {userInfo && (
          <p className="text-xs text-white/55 m-0">
            Signed in as <span className="text-[#f5f5f5]">{userInfo.preferred_username}</span> ({userInfo.email})
          </p>
        )}

        <div className="border border-white/[0.08] rounded-lg overflow-hidden bg-surface">
          <div className="px-3.5 py-2 border-b border-white/[0.08] text-[0.65rem] uppercase tracking-widest text-white/35">
            demo.ts
          </div>
          <Editor
            height="280px"
            defaultLanguage="typescript"
            value={code}
            onMount={handleEditorMount}
            onChange={(next) => setCode(next ?? "")}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineHeight: 22,
              padding: { top: 14, bottom: 14 },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              tabSize: 2,
              automaticLayout: true,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          />
        </div>

        {outputText && (
          <div className="border border-white/[0.08] rounded-lg bg-black/30">
            <div className="px-3.5 py-2 border-b border-white/[0.08] text-[0.65rem] uppercase tracking-widest text-white/35">
              result.json
            </div>
            <pre className="m-0 p-3.5 overflow-x-auto text-xs text-white/70 leading-6">{outputText}</pre>
          </div>
        )}

        {error && <p className="m-0 text-sm text-red-300/90">{error}</p>}
      </div>
    </div>
  );
}
