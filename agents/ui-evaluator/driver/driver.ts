// browser-driver — a reference, zero-dependency headless-browser driver for the
// ui-evaluator agent. It speaks raw Chrome DevTools Protocol (CDP) over a
// Chromium-family browser the user already has, using only Bun built-ins
// (Bun's global WebSocket + fetch, node: builtins). No npm packages, no
// node_modules, no telemetry, no background network of its own.
//
// It implements exactly the small command contract that capture.sh shells out to:
//   viewport <WxH> --scale <n>   set device metrics + device-pixel-ratio
//   useragent <ua-string>        set the user-agent
//   goto <url>                   navigate
//   wait --networkidle           wait for the page to settle
//   eval <script-file>           run a JS file in the page, print its return value
//   console --errors             print captured console errors
//   screenshot <out.png>         write a full-page screenshot
//   doctor | setup [--install]   report the browser it found (or guide install)
//   stop | quit                  tear the shared browser down cleanly
//
// State model: launch the browser ONCE (headless, its own remote-debugging port
// and throwaway profile), remember the endpoint + the desired viewport/UA in a
// state dir under the OS temp dir (never the repo), and have each later command
// re-attach to the same browser and re-apply the emulation before it acts. CDP
// emulation overrides are per-connection, so we set them on every command that
// navigates or captures.
//
// AUTH is intentionally NOT here. Signing in and handing over an authenticated
// browser context is the caller's responsibility (see the agent README). This
// driver mints no sessions, holds no credentials, and reads no secret store.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Small utilities
// ─────────────────────────────────────────────────────────────────────────────
const err = (...a: unknown[]) => console.error(...a);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function die(msg: string, code = 1): never {
  err(msg);
  process.exit(code);
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser detection — a Chromium-family browser the user already has installed.
// Honors an explicit AGIX_BROWSER_BIN override first.
// ─────────────────────────────────────────────────────────────────────────────
function macApps(): string[] {
  const roots = ["/Applications", join(homedir(), "Applications")];
  const apps: [string, string][] = [
    ["Google Chrome.app", "Google Chrome"],
    ["Google Chrome Canary.app", "Google Chrome Canary"],
    ["Chromium.app", "Chromium"],
    ["Microsoft Edge.app", "Microsoft Edge"],
    ["Brave Browser.app", "Brave Browser"],
    ["Arc.app", "Arc"],
    ["Vivaldi.app", "Vivaldi"],
  ];
  const out: string[] = [];
  for (const root of roots)
    for (const [app, bin] of apps)
      out.push(join(root, app, "Contents", "MacOS", bin));
  return out;
}

function linuxCandidates(): string[] {
  const names = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    "chrome",
    "microsoft-edge",
    "microsoft-edge-stable",
    "brave-browser",
    "vivaldi",
  ];
  const dirs = ["/usr/bin", "/usr/local/bin", "/snap/bin", "/opt/google/chrome"];
  const out: string[] = [];
  for (const d of dirs) for (const n of names) out.push(join(d, n));
  // Also let a bare name resolve through PATH.
  out.push(...names);
  return out;
}

// Resolve a bare command name through PATH without spawning a shell.
function onPath(name: string): string | null {
  if (name.includes("/")) return existsSync(name) ? name : null;
  const PATH = process.env.PATH ?? "";
  for (const d of PATH.split(":")) {
    if (!d) continue;
    const p = join(d, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function findBrowser(): string | null {
  const override = process.env.AGIX_BROWSER_BIN;
  if (override) return existsSync(override) ? override : (onPath(override) ?? null);
  const candidates = platform() === "darwin" ? macApps() : linuxCandidates();
  for (const c of candidates) {
    const hit = onPath(c);
    if (hit) return hit;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// State (shared browser endpoint + desired emulation), under the OS temp dir.
// ─────────────────────────────────────────────────────────────────────────────
type Viewport = { w: number; h: number; scale: number };
type State = {
  bin?: string;
  port?: number;
  pid?: number;
  userDataDir?: string;
  targetId?: string;
  viewport?: Viewport;
  userAgent?: string;
};

function stateDir(): string {
  const d = join(tmpdir(), "agix-ui-evaluator-driver");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}
const statePath = () => join(stateDir(), "state.json");
const consolePath = () => join(stateDir(), "console-errors.log");

function readState(): State {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as State;
  } catch {
    return {};
  }
}
function writeState(patch: Partial<State>): State {
  const next = { ...readState(), ...patch };
  writeFileSync(statePath(), JSON.stringify(next, null, 2));
  return next;
}

// ─────────────────────────────────────────────────────────────────────────────
// A minimal CDP client over Bun's global WebSocket.
// ─────────────────────────────────────────────────────────────────────────────
class CDP {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
  private handlers = new Map<string, ((p: any) => void)[]>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async connect(wsUrl: string, timeoutMs = 10000): Promise<CDP> {
    const ws = new WebSocket(wsUrl);
    const cdp = new CDP(ws);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP connect timeout")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        reject(new Error("CDP websocket error"));
      }, { once: true });
    });
    ws.addEventListener("message", (ev: MessageEvent) => cdp.onMessage(String(ev.data)));
    return cdp;
  }

  private onMessage(data: string) {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message ?? "CDP error"));
        else p.res(msg.result);
      }
    } else if (msg.method) {
      for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, handler: (p: any) => void) {
    const arr = this.handlers.get(event) ?? [];
    arr.push(handler);
    this.handlers.set(event, arr);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser lifecycle
// ─────────────────────────────────────────────────────────────────────────────
async function portAlive(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function pidAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function launchBrowser(): Promise<State> {
  const bin = findBrowser();
  if (!bin) {
    printGuidance();
    process.exit(3);
  }
  const userDataDir = join(stateDir(), "profile");
  // A throwaway profile the driver owns. Flags disable first-run UX and the
  // browser's OWN background networking — the only network we want is the
  // caller's goto navigations.
  const flags = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
  ];
  const activePortFile = join(userDataDir, "DevToolsActivePort");
  try {
    rmSync(activePortFile, { force: true });
  } catch {
    /* fresh */
  }
  const proc = Bun.spawn([bin, ...flags], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  proc.unref();

  // Chrome writes the chosen port to DevToolsActivePort once the endpoint is up.
  let port = 0;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (existsSync(activePortFile)) {
      const first = readFileSync(activePortFile, "utf8").split("\n")[0]?.trim();
      const n = Number(first);
      if (n > 0 && (await portAlive(n))) {
        port = n;
        break;
      }
    }
    await sleep(150);
  }
  if (!port) die("browser-driver: the browser did not expose a debugging port in time.", 5);
  return writeState({ bin, port, pid: proc.pid, userDataDir, targetId: undefined });
}

async function ensureBrowser(): Promise<State> {
  const st = readState();
  if (st.port && pidAlive(st.pid) && (await portAlive(st.port))) return st;
  return launchBrowser();
}

// Attach to (or create) a page target on the shared browser and return its ws URL.
async function pageWsUrl(port: number): Promise<string> {
  const st = readState();
  let list: any[] = [];
  try {
    list = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as any[];
  } catch {
    list = [];
  }
  const pages = list.filter((t) => t.type === "page");
  let page = pages.find((p) => p.id === st.targetId) ?? pages[0];
  if (!page) {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    page = await r.json();
  }
  writeState({ targetId: page.id });
  return page.webSocketDebuggerUrl as string;
}

async function attach(): Promise<{ cdp: CDP; st: State }> {
  const st = await ensureBrowser();
  const wsUrl = await pageWsUrl(st.port!);
  const cdp = await CDP.connect(wsUrl);
  return { cdp, st };
}

// Re-apply the caller's desired viewport + UA. CDP overrides are per-connection,
// so every navigating/capturing command must set them again.
async function applyEmulation(cdp: CDP, st: State) {
  const ua = st.userAgent ?? "";
  if (ua) {
    const mobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: ua });
    await cdp.send("Network.setUserAgentOverride", { userAgent: ua }).catch(() => {});
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile }).catch(() => {});
  }
  if (st.viewport) {
    const mobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: st.viewport.w,
      height: st.viewport.h,
      deviceScaleFactor: st.viewport.scale,
      mobile,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Console-error capture. Each command runs in its own process, so we buffer
// errors to a file: goto truncates it, wait appends, console --errors reads it.
// ─────────────────────────────────────────────────────────────────────────────
function argsToText(args: any[] = []): string {
  return args
    .map((a) =>
      a?.value !== undefined
        ? String(a.value)
        : a?.description ?? a?.unserializableValue ?? a?.type ?? "",
    )
    .join(" ")
    .trim();
}

function subscribeErrors(cdp: CDP, sink: string[]) {
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p?.type === "error" || p?.type === "assert") {
      const t = argsToText(p.args);
      if (t) sink.push(`[console.${p.type}] ${t}`);
    }
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    const d = p?.exceptionDetails;
    const t = d?.exception?.description ?? d?.text ?? "uncaught exception";
    sink.push(`[exception] ${String(t).split("\n")[0]}`);
  });
  cdp.on("Log.entryAdded", (p) => {
    const e = p?.entry;
    if (e?.level === "error") sink.push(`[${e.source ?? "log"}] ${String(e.text ?? "").trim()}`);
  });
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    if (!l) continue;
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

function writeConsole(lines: string[], append: boolean) {
  const prev = append && existsSync(consolePath()) ? readFileSync(consolePath(), "utf8").split("\n") : [];
  const all = dedupe([...prev, ...lines]).filter((l) => l.length);
  writeFileSync(consolePath(), all.length ? all.join("\n") + "\n" : "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Command handlers
// ─────────────────────────────────────────────────────────────────────────────
async function cmdViewport(args: string[]) {
  const size = args[0]; // WxH
  const scaleIdx = args.indexOf("--scale");
  const scale = scaleIdx >= 0 ? Number(args[scaleIdx + 1]) : 1;
  const m = /^(\d+)x(\d+)$/i.exec(size ?? "");
  if (!m) die("usage: driver viewport <WxH> --scale <n>", 2);
  writeState({ viewport: { w: Number(m[1]), h: Number(m[2]), scale: scale > 0 ? scale : 1 } });
}

async function cmdUserAgent(args: string[]) {
  const ua = args.join(" ").trim();
  if (!ua) die("usage: driver useragent <ua-string>", 2);
  writeState({ userAgent: ua });
}

async function cmdGoto(args: string[]) {
  const url = args[0];
  if (!url) die("usage: driver goto <url>", 2);
  const { cdp, st } = await attach();
  const errors: string[] = [];
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  subscribeErrors(cdp, errors);
  await applyEmulation(cdp, st);
  // Navigate and wait for the load event (bounded); wait --networkidle settles the rest.
  const loaded = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 30000);
    cdp.on("Page.loadEventFired", () => {
      clearTimeout(t);
      resolve();
    });
  });
  const nav = await cdp.send("Page.navigate", { url });
  if (nav?.errorText) err(`browser-driver: navigation warning: ${nav.errorText}`);
  await loaded;
  await sleep(150); // let synchronous on-load errors flush
  writeConsole(errors, false);
  cdp.close();
}

async function cmdWait(args: string[]) {
  if (!args.includes("--networkidle")) die("usage: driver wait --networkidle", 2);
  const { cdp, st } = await attach();
  const errors: string[] = [];
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable").catch(() => {});
  subscribeErrors(cdp, errors);
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});

  let inflight = 0;
  let lifecycleIdle = false;
  cdp.on("Network.requestWillBeSent", () => inflight++);
  cdp.on("Network.loadingFinished", () => inflight--);
  cdp.on("Network.loadingFailed", () => inflight--);
  cdp.on("Network.requestServedFromCache", () => {});
  cdp.on("Page.lifecycleEvent", (p) => {
    if (p?.name === "networkIdle") lifecycleIdle = true;
  });

  // Settle heuristic: resolve when the network has been quiet (no in-flight
  // requests) for a short window, OR the browser reports networkIdle, OR we hit
  // an overall cap. We attach AFTER goto's load event, so this catches trailing
  // XHR / lazy assets; a fully-settled page returns after the quiet window.
  const OVERALL = 15000;
  const QUIET = 600;
  await new Promise<void>((resolve) => {
    const start = Date.now();
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (quietTimer) clearTimeout(quietTimer);
      clearInterval(iv);
      resolve();
    };
    const iv = setInterval(() => {
      if (lifecycleIdle || Date.now() - start > OVERALL) return finish();
      if (inflight <= 0) {
        if (!quietTimer) quietTimer = setTimeout(finish, QUIET);
      } else if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
    }, 100);
  });
  writeConsole(errors, true);
  cdp.close();
}

async function cmdEval(args: string[]) {
  const file = args[0];
  if (!file || !existsSync(file)) die(`usage: driver eval <script-file>  (not found: ${file ?? ""})`, 2);
  const expression = readFileSync(file, "utf8");
  const { cdp, st } = await attach();
  await cdp.send("Runtime.enable");
  await applyEmulation(cdp, st);
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    die(`browser-driver: eval threw: ${d.exception?.description ?? d.text ?? "error"}`, 6);
  }
  const v = r?.result?.value;
  process.stdout.write(typeof v === "string" ? v : JSON.stringify(v ?? null));
  process.stdout.write("\n");
  cdp.close();
}

async function cmdConsole(args: string[]) {
  if (!args.includes("--errors")) die("usage: driver console --errors", 2);
  if (!existsSync(consolePath())) return; // nothing captured → empty output
  const lines = dedupe(readFileSync(consolePath(), "utf8").split("\n").filter((l) => l.trim()));
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
}

async function cmdScreenshot(args: string[]) {
  const out = args[0];
  if (!out) die("usage: driver screenshot <out.png>", 2);
  const { cdp, st } = await attach();
  await cdp.send("Page.enable");
  await applyEmulation(cdp, st);
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const size = metrics?.cssContentSize ?? metrics?.contentSize ?? { width: st.viewport?.w ?? 1280, height: st.viewport?.h ?? 800 };
  const width = Math.max(1, Math.ceil(size.width));
  const height = Math.max(1, Math.ceil(size.height));
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height, scale: 1 },
  });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  cdp.close();
}

async function cmdStop() {
  const st = readState();
  if (st.port && (await portAlive(st.port))) {
    try {
      const ver = (await (await fetch(`http://127.0.0.1:${st.port}/json/version`)).json()) as any;
      if (ver?.webSocketDebuggerUrl) {
        const cdp = await CDP.connect(ver.webSocketDebuggerUrl, 3000);
        await cdp.send("Browser.close").catch(() => {});
        cdp.close();
      }
    } catch {
      /* fall through to kill */
    }
  }
  if (pidAlive(st.pid)) {
    try {
      process.kill(st.pid!);
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(statePath(), { force: true });
    rmSync(consolePath(), { force: true });
    if (st.userDataDir) rmSync(st.userDataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  err("browser-driver: stopped the shared browser and cleared its state.");
}

// ─────────────────────────────────────────────────────────────────────────────
// doctor / setup + guided install
// ─────────────────────────────────────────────────────────────────────────────
function printGuidance() {
  const isMac = platform() === "darwin";
  err("");
  err("browser-driver: no Chromium-family browser found.");
  err("This agent drives a headless browser you already have. Install one of:");
  err("  • Google Chrome, Chromium, Microsoft Edge, Brave, Arc, or Vivaldi");
  err("");
  if (isMac) {
    err("On macOS, the quickest is Homebrew:");
    err("    brew install --cask chromium");
    err("  (or: brew install --cask google-chrome)");
    err("Then re-run. Prefer a specific binary? Point the driver at it:");
    err("    export AGIX_BROWSER_BIN=\"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\"");
  } else {
    err("On Linux, install via your package manager:");
    err("    Debian/Ubuntu:  sudo apt-get install -y chromium         (or chromium-browser)");
    err("    Fedora:         sudo dnf install -y chromium");
    err("    Arch:           sudo pacman -S chromium");
    err("    openSUSE:       sudo zypper install -y chromium");
    err("Then re-run. Prefer a specific binary? Point the driver at it:");
    err("    export AGIX_BROWSER_BIN=/usr/bin/chromium");
  }
  err("");
  err("Or run guided setup:  driver doctor --install   (asks before installing anything)");
  err("");
}

async function cmdDoctor(args: string[]) {
  const wantInstall = args.includes("--install");
  err(`browser-driver doctor`);
  err(`  runtime : Bun ${Bun.version}`);
  err(`  platform: ${platform()}`);
  err(`  state   : ${stateDir()}`);
  if (process.env.AGIX_BROWSER_BIN) err(`  override: AGIX_BROWSER_BIN=${process.env.AGIX_BROWSER_BIN}`);
  let bin = findBrowser();
  if (bin) {
    err(`  browser : ✓ ${bin}`);
    err("Ready. capture.sh will drive this browser out of the box.");
    process.exit(0);
  }

  // No browser. Offer a consented, one-time install on macOS; never auto-run.
  const isMac = platform() === "darwin";
  const tty = Boolean(process.stdin.isTTY);
  let proceed = wantInstall;
  if (!proceed && isMac && tty) {
    const ans = prompt("No browser found. Install Chromium via Homebrew now? [y/N]");
    proceed = /^y(es)?$/i.test((ans ?? "").trim());
  }

  if (proceed && isMac) {
    const brew = onPath("brew");
    if (!brew) {
      err("  browser : ✗ none found — and Homebrew is not installed.");
      err("Install Homebrew first (https://brew.sh), then: brew install --cask chromium");
      process.exit(1);
    }
    err("  installing Chromium via Homebrew (this is the one network action, and you consented)…");
    const p = Bun.spawnSync(["brew", "install", "--cask", "chromium"], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    bin = findBrowser();
    if (p.exitCode === 0 && bin) {
      err(`  browser : ✓ ${bin}`);
      err("Installed. capture.sh will drive this browser now.");
      process.exit(0);
    }
    err("  install did not complete. See output above.");
    printGuidance();
    process.exit(1);
  }

  err("  browser : ✗ none found");
  printGuidance();
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────
function usage(): never {
  err("browser-driver — reference CDP driver for the ui-evaluator agent");
  err("commands:");
  err("  viewport <WxH> --scale <n>   set device metrics + DPR");
  err("  useragent <ua-string>        set the user-agent");
  err("  goto <url>                   navigate");
  err("  wait --networkidle           wait for the page to settle");
  err("  eval <script-file>           run a JS file in the page, print its return");
  err("  console --errors             print captured console errors");
  err("  screenshot <out.png>         write a full-page screenshot");
  err("  doctor | setup [--install]   report the detected browser (or guide install)");
  err("  stop | quit                  tear the shared browser down cleanly");
  process.exit(2);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "viewport": return cmdViewport(args);
    case "useragent": return cmdUserAgent(args);
    case "goto": return cmdGoto(args);
    case "wait": return cmdWait(args);
    case "eval": return cmdEval(args);
    case "console": return cmdConsole(args);
    case "screenshot": return cmdScreenshot(args);
    case "doctor":
    case "setup": return cmdDoctor(args);
    case "stop":
    case "quit": return cmdStop();
    default: return usage();
  }
}

main().catch((e) => {
  err(`browser-driver: ${e?.message ?? e}`);
  process.exit(1);
});
