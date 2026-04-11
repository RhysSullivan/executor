import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;

function check(label, actual, expected) {
  if (actual === expected) {
    console.log("  PASS", label);
    pass++;
  } else {
    console.log("  FAIL", label);
    console.log("       expected:", JSON.stringify(expected));
    console.log("       got:     ", JSON.stringify(actual));
    fail++;
  }
}

// ---------------------------------------------------------------------------
// 1. File secrets: xdgDataHome on Windows
// ---------------------------------------------------------------------------
console.log("\n[1] file-secrets xdgDataHome");
{
  // Temporarily unset XDG_DATA_HOME — Git Bash sets it, but real Windows apps don't
  const savedXdg = process.env.XDG_DATA_HOME;
  delete process.env.XDG_DATA_HOME;
  const xdgDataHome = () => {
    if (process.env.XDG_DATA_HOME?.trim()) return process.env.XDG_DATA_HOME.trim();
    if (process.platform === "win32") {
      return process.env.LOCALAPPDATA || process.env.APPDATA || path.join(process.env.USERPROFILE || "~", "AppData", "Local");
    }
    return path.join(process.env.HOME || "~", ".local", "share");
  };
  const result = xdgDataHome();
  if (savedXdg) process.env.XDG_DATA_HOME = savedXdg;
  const isWindows = process.platform === "win32";
  const looksRight = isWindows
    ? result.toLowerCase().includes("appdata")
    : result.includes(".local/share");
  check("resolves to correct dir for platform", String(looksRight), "true");
  if (savedXdg) console.log("  note: XDG_DATA_HOME was set by shell to", savedXdg, "(ignored in real Windows apps)");
  console.log("  path (without XDG override):", result);
  console.log("  auth.json:", path.join(result, "executor", "auth.json"));
}

// ---------------------------------------------------------------------------
// 2. Deno executable lookup
// ---------------------------------------------------------------------------
console.log("\n[2] Deno executable lookup");
{
  const isWindows = process.platform === "win32";
  const home = (process.env.HOME || process.env.USERPROFILE || "").trim();
  const installedPath = isWindows
    ? path.join(home, ".deno", "bin", "deno.exe")
    : path.join(home, ".deno", "bin", "deno");

  check("home is non-empty", String(home.length > 0), "true");
  console.log("  home:", home);
  console.log("  trying:", installedPath);

  const r = spawnSync(installedPath, ["--version"], { stdio: "pipe", timeout: 5000 });
  if (r.status === 0) {
    console.log("  PASS found deno at standard install path:", r.stdout.toString().split("\n")[0]);
    pass++;
  } else {
    console.log("  INFO deno not at standard path (ok if installed elsewhere, falls back to PATH)");
    // Verify bare "deno" works as fallback
    const r2 = spawnSync("deno", ["--version"], { stdio: "pipe", timeout: 5000 });
    check("bare 'deno' fallback works", String(r2.status === 0), "true");
    if (r2.status === 0) console.log("  deno version:", r2.stdout.toString().split("\n")[0]);
  }
}

// ---------------------------------------------------------------------------
// 3. scope path display — basename fix (desktop/main.ts)
// ---------------------------------------------------------------------------
console.log("\n[3] scope path display (basename)");
{
  const cases = [
    ["C:\\Users\\name\\projects\\myapp",   "myapp"],
    ["C:\\Users\\name\\projects\\myapp\\", "myapp"],
    ["D:\\work\\repo",                     "repo"],
    ["/home/user/projects/myapp",          "myapp"],
    ["/home/user/projects/myapp/",         "myapp"],
  ];
  for (const [input, expected] of cases) {
    const result = path.basename(input.replace(/[/\\]+$/, "")) || input;
    check(JSON.stringify(input), result, expected);
  }
}

// ---------------------------------------------------------------------------
// 4. ScopeLabel path split fix (shell.tsx)
// ---------------------------------------------------------------------------
console.log("\n[4] ScopeLabel split");
{
  const cases = [
    ["C:\\Users\\name\\projects\\myapp",   "myapp"],
    ["C:\\Users\\name\\projects\\myapp\\", "myapp"],
    ["D:\\work\\repo",                     "repo"],
    ["/home/user/projects/myapp",          "myapp"],
    ["/home/user/projects/myapp/",         "myapp"],
  ];
  for (const [input, expected] of cases) {
    const parts = input.replace(/[/\\]+$/, "").split(/[/\\]/);
    const folder = parts[parts.length - 1] || input;
    check(JSON.stringify(input), folder, expected);
  }
}

// ---------------------------------------------------------------------------
// 5. pwsh availability (postinstall fallback chain)
// ---------------------------------------------------------------------------
console.log("\n[5] pwsh availability");
{
  const r = spawnSync("pwsh", ["--version"], { stdio: "pipe", timeout: 5000 });
  check("pwsh found", String(r.status === 0), "true");
  if (r.status === 0) console.log(" ", r.stdout.toString().trim());
}

// ---------------------------------------------------------------------------
// 6. Windows registry PATH check
// ---------------------------------------------------------------------------
console.log("\n[6] registry PATH readable");
{
  if (process.platform !== "win32") {
    console.log("  SKIP (not Windows)");
  } else {
    const r = spawnSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { stdio: "pipe", encoding: "utf8" });
    check("reg query exits 0", String(r.status === 0), "true");
    if (r.status === 0) {
      const match = r.stdout.match(/Path\s+REG(?:_EXPAND)?_SZ\s+(.+)/i);
      console.log("  current user PATH entry exists:", String(!!match));
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass + fail} checks: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
