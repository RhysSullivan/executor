"use client";

import React, { useEffect, useRef, useState } from "react";

/**
 * Interactive "no context bloat" demo, laid out like Effect's "Production-grade
 * TypeScript" section: a complexity gauge + service checklist on top, then two
 * code windows below. Check services to connect them. The naive side grows a
 * system prompt that lists every tool name, ballooning into the thousands (tall
 * + scrollable); the Executor side stays at one `execute` tool with a short,
 * fixed description. Figures are illustrative; the shape is accurate.
 */

type Integration = {
  readonly slug: string;
  readonly name: string;
  readonly tools: number;
  readonly naiveTok: number;
  readonly toolNames: ReadonlyArray<string>;
  readonly summary: string;
};

// Each integration imports its whole API surface as tools (OpenAPI ops, MCP
// tools, GraphQL fields), so a handful already stacks into the thousands.
// naiveTok ~= tools * 170 (one tool definition with its JSON schema).
const INTEGRATIONS: ReadonlyArray<Integration> = [
  {
    slug: "github",
    name: "GitHub",
    tools: 720,
    naiveTok: 122400,
    toolNames: [
      "createIssue",
      "listPullRequests",
      "mergePullRequest",
      "createRelease",
      "addLabels",
      "createBranch",
      "getCommit",
    ],
    summary: "Production GitHub",
  },
  {
    slug: "stripe",
    name: "Stripe",
    tools: 510,
    naiveTok: 86700,
    toolNames: [
      "createCharge",
      "createCustomer",
      "createRefund",
      "listInvoices",
      "createSubscription",
      "capturePaymentIntent",
      "listPayouts",
    ],
    summary: "Live Stripe account",
  },
  {
    slug: "jira",
    name: "Jira",
    tools: 240,
    naiveTok: 40800,
    toolNames: [
      "createIssue",
      "transitionIssue",
      "addComment",
      "assignIssue",
      "listSprints",
      "createProject",
      "searchIssues",
    ],
    summary: "Team Jira",
  },
  {
    slug: "sentry",
    name: "Sentry",
    tools: 170,
    naiveTok: 28900,
    toolNames: [
      "listIssues",
      "resolveIssue",
      "listEvents",
      "getProject",
      "muteIssue",
      "createRelease",
      "listAlerts",
    ],
    summary: "Production Sentry",
  },
  {
    slug: "linear",
    name: "Linear",
    tools: 130,
    naiveTok: 22100,
    toolNames: [
      "createIssue",
      "updateIssue",
      "listProjects",
      "createComment",
      "archiveIssue",
      "listTeams",
      "createLabel",
    ],
    summary: "Linear workspace",
  },
  {
    slug: "gmail",
    name: "Gmail",
    tools: 95,
    naiveTok: 16150,
    toolNames: [
      "sendMessage",
      "listThreads",
      "createDraft",
      "addLabel",
      "trashMessage",
      "listMessages",
      "modifyMessage",
    ],
    summary: "Support inbox",
  },
  {
    slug: "notion",
    name: "Notion",
    tools: 80,
    naiveTok: 13600,
    toolNames: [
      "queryDatabase",
      "createPage",
      "updateBlock",
      "appendChildren",
      "search",
      "retrievePage",
      "listUsers",
    ],
    summary: "Internal Notion",
  },
  {
    slug: "slack",
    name: "Slack",
    tools: 70,
    naiveTok: 11900,
    toolNames: [
      "postMessage",
      "listChannels",
      "createChannel",
      "inviteToChannel",
      "uploadFile",
      "listUsers",
      "setTopic",
    ],
    summary: "Team Slack",
  },
];

// The execute tool's description is a fixed preamble (workflow + rules) plus one
// short prefix line per connected integration. It stays flat as you add
// integrations, no matter how many tools each one carries.
const EXECUTOR_BASE = 980; // fixed workflow + rules preamble, served once
const EXECUTOR_PER = 16; // one connection-prefix line per integration
const NAIVE_MAX = INTEGRATIONS.reduce((s, i) => s + i.naiveTok, 0); // bar scale

const fmt = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/** Eases a displayed integer toward `target` with requestAnimationFrame. */
function useAnimatedNumber(target: number): number {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      setDisplay(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    const dur = 450;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (target - from) * eased));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      fromRef.current = target;
    };
  }, [target, reduced]);

  return display;
}

const ICON_PATHS: Record<string, string> = {
  github:
    "M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z",
  stripe:
    "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
  linear:
    "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
  gmail:
    "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
  jira: "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z",
  sentry:
    "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
  notion:
    "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
  slack:
    "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.527 2.527 0 0 1 2.521 2.521 2.527 2.527 0 0 1-2.521 2.521H2.522A2.527 2.527 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.271 0a2.528 2.528 0 0 1-2.521 2.521 2.527 2.527 0 0 1-2.521-2.521V2.522A2.527 2.527 0 0 1 15.164 0a2.528 2.528 0 0 1 2.521 2.522v6.312zM15.164 18.956a2.528 2.528 0 0 1 2.521 2.522A2.528 2.528 0 0 1 15.164 24a2.527 2.527 0 0 1-2.521-2.522v-2.522h2.521zm0-1.271a2.527 2.527 0 0 1-2.521-2.521 2.527 2.527 0 0 1 2.521-2.521h6.314A2.527 2.527 0 0 1 24 15.164a2.528 2.528 0 0 1-2.522 2.521h-6.314z",
};

function IntegrationIcon({ slug }: { readonly slug: string }) {
  const d = ICON_PATHS[slug];
  if (!d) return null;
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="15" height="15" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function CheckMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      width="11"
      height="11"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function TokenBar({
  pct,
  variant,
}: {
  readonly pct: number;
  readonly variant: "naive" | "executor";
}) {
  return (
    <div className={`cbloat-bar cbloat-bar--${variant}`} aria-hidden="true">
      <div className="cbloat-bar__fill" style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
    </div>
  );
}

export function ContextBloatDemo() {
  const [active, setActive] = useState<ReadonlyArray<string>>([
    "github",
    "stripe",
    "jira",
    "sentry",
  ]);
  const isOn = (slug: string) => active.includes(slug);
  const toggle = (slug: string) =>
    setActive((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));

  const activeIntegrations = INTEGRATIONS.filter((i) => isOn(i.slug));
  const naiveTok = activeIntegrations.reduce((s, i) => s + i.naiveTok, 0);
  const naiveTools = activeIntegrations.reduce((s, i) => s + i.tools, 0);
  const executorTok = EXECUTOR_BASE + active.length * EXECUTOR_PER;

  const naiveDisplay = useAnimatedNumber(naiveTok);
  const executorDisplay = useAnimatedNumber(executorTok);
  const naiveToolsDisplay = useAnimatedNumber(naiveTools);

  const naivePct = (naiveTok / NAIVE_MAX) * 100;
  const executorPct = (executorTok / NAIVE_MAX) * 100;

  return (
    <div className="cbloat">
      <p className="sr-only" aria-live="polite">
        Without Executor: {fmt(naiveTools)} tools, about {fmt(naiveTok)} tokens. With Executor: 1
        tool, about {fmt(executorTok)} tokens.
      </p>

      <div className="cbloat-top">
        {/* Complexity gauge */}
        <div className="cbloat-gauge">
          <div className="cbloat-gauge__title">Context window</div>
          <div className="cbloat-gauge__sub">Lower is better</div>
          <div className="cbloat-gauge__row">
            <div className="cbloat-gauge__line">
              <span className="cbloat-dot cbloat-dot--naive" />
              <span className="cbloat-gauge__name">Without Executor</span>
              <span className="cbloat-gauge__val">
                {fmt(naiveToolsDisplay)} tools &middot; ~{fmt(naiveDisplay)} tok
              </span>
            </div>
            <TokenBar pct={naivePct} variant="naive" />
          </div>
          <div className="cbloat-gauge__row">
            <div className="cbloat-gauge__line">
              <span className="cbloat-dot cbloat-dot--exec" />
              <span className="cbloat-gauge__name">With Executor</span>
              <span className="cbloat-gauge__val">1 tool &middot; ~{fmt(executorDisplay)} tok</span>
            </div>
            <TokenBar pct={executorPct} variant="executor" />
          </div>
        </div>

        {/* Service checklist */}
        <div className="cbloat-checklist" role="group" aria-label="Connect services">
          {INTEGRATIONS.map((i) => (
            <button
              key={i.slug}
              type="button"
              className="cbloat-check"
              data-on={isOn(i.slug) ? "true" : undefined}
              aria-pressed={isOn(i.slug)}
              onClick={() => toggle(i.slug)}
            >
              <span className="cbloat-check__box" aria-hidden="true">
                {isOn(i.slug) ? <CheckMark /> : null}
              </span>
              <span className="cbloat-check__icon">
                <IntegrationIcon slug={i.slug} />
              </span>
              <span className="cbloat-check__name">{i.name}</span>
              <span className="cbloat-check__count">{fmt(i.tools)} tools</span>
            </button>
          ))}
        </div>
      </div>

      <div className="cbloat-grid">
        {/* Without Executor: a system prompt that lists every tool, scrollable */}
        <div className="cbloat-col">
          <div className="cbloat-col__title">Without Executor</div>
          <div className="code-window cbloat-panel cbloat-panel--naive">
            <div className="code-window__bar">
              <span className="code-window__dots">
                <i />
                <i />
                <i />
              </span>
              <span className="cbloat-panel__count">
                <span className="cbloat-num">{fmt(naiveToolsDisplay)}</span> tools &middot; ~
                {fmt(naiveDisplay)} tok
              </span>
            </div>
            <pre className="code-window__body cbloat-body cbloat-body--scroll">
              <code>
                <span className="tok-s">{'"You are a helpful assistant.'}</span>
                {"\n\n"}
                {"Your tools are:"}
                {"\n\n"}
                {activeIntegrations.length === 0 ? (
                  <span className="tok-c">{"(none yet, check a service)"}</span>
                ) : null}
                {activeIntegrations.map((i) => (
                  <React.Fragment key={i.slug}>
                    {i.toolNames.map((n) => (
                      <React.Fragment key={n}>
                        <span className="tok-a">{n}</span>
                        <span className="tok-p">()</span>
                        {"\n"}
                      </React.Fragment>
                    ))}
                    <span className="tok-c">{`// + ${fmt(i.tools - i.toolNames.length)} more ${i.name} tools`}</span>
                    {"\n"}
                  </React.Fragment>
                ))}
                {activeIntegrations.length > 0 ? <span className="tok-s">{'..."'}</span> : null}
              </code>
            </pre>
          </div>
        </div>

        {/* With Executor: one tool, the same trimmed description */}
        <div className="cbloat-col">
          <div className="cbloat-col__title">With Executor</div>
          <div className="code-window cbloat-panel cbloat-panel--executor">
            <div className="code-window__bar">
              <span className="code-window__dots">
                <i />
                <i />
                <i />
              </span>
              <span className="cbloat-panel__count">
                1 tool &middot; ~<span className="cbloat-num">{fmt(executorDisplay)}</span> tok
              </span>
            </div>
            <pre className="code-window__body cbloat-body cbloat-body--scroll">
              <code>
                <span className="tok-c">{'// the only tool your client sees: "execute"'}</span>
                {"\n\n"}
                {
                  "Execute TypeScript in a sandboxed runtime with access to\nconfigured API tools.\n\n"
                }
                <span className="tok-f">{"## Workflow"}</span>
                {"\n\n"}
                {"1. const { items } = await tools.search({ query });\n"}
                {"2. const path = items[0]?.path;\n"}
                {"3. const details = await tools.describe.tool({ path });\n"}
                {"4. const result = await tools[path](input);\n\n"}
                <span className="tok-f">{"## Available connection prefixes"}</span>
                {"\n\n"}
                {activeIntegrations.length === 0 ? (
                  <span className="tok-c">{"(connect a service to add a prefix)"}</span>
                ) : null}
                {activeIntegrations.map((i) => (
                  <span key={i.slug} className="cbloat-line">
                    <span className="tok-p">{"- "}</span>
                    <span className="tok-a">{`${i.slug}.org.main`}</span>
                    <span className="tok-p">{": "}</span>
                    <span className="tok-c">{i.summary}</span>
                    {"\n"}
                  </span>
                ))}
              </code>
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
