# ui-evaluator — governed UI-quality evaluation (mobile + desktop)

A re-runnable evaluator that drives any web app at real device sizes, captures evidence, and scores
how the UI holds up across **Apple + Android phones, tablet, and desktop** — so every new surface gets
evaluated as it is built, and a re-run after a fix shows the delta.

It is two tiers, and they do not merge:

- **`capture.sh` + `probe.js`** — the deterministic engine. Drives a pluggable headless-browser
  driver at a device profile and writes, per route x device: a screenshot, a metrics JSON, and console
  errors.
- **The vision judge** (the agent's behavior — `agent.json` `instructions`) — after the capture, a
  vision model scores each route across its devices and emits a ranked P0-P3 report.

## Prerequisite: a browser-driver substrate (a reference driver is bundled)

This agent needs a **headless browser it can drive**. A **reference driver is now bundled** at
`driver/` and used **by default**, so the agent is plug-and-play: if `BROWSER_DRIVER` is unset,
`capture.sh` resolves the bundled `driver/browser-driver` next to it. You still need one thing on the
machine — **a Chromium-family browser** (Google Chrome, Chromium, Microsoft Edge, Brave, Arc, or
Vivaldi). Most dev machines already have one; if not, `driver doctor` walks you through installing it
(see below).

The bundled driver speaks **raw Chrome DevTools Protocol (CDP)** over that browser using **Bun
built-ins only** — zero npm dependencies, no `node_modules`, no telemetry, and no network of its own
beyond your `goto` navigations. It implements this small contract:

| Command | Purpose |
|---|---|
| `"$BROWSER_DRIVER" viewport <WxH> --scale <n>` | set device size + device-pixel-ratio |
| `"$BROWSER_DRIVER" useragent <ua-string>` | set the user-agent |
| `"$BROWSER_DRIVER" goto <url>` | navigate to a URL |
| `"$BROWSER_DRIVER" wait --networkidle` | wait for the page to settle |
| `"$BROWSER_DRIVER" eval <script-file>` | run a JS file in the page, print its return value |
| `"$BROWSER_DRIVER" console --errors` | print captured console errors |
| `"$BROWSER_DRIVER" screenshot <out.png>` | write a full-page screenshot |

It launches the browser **once** (headless, its own debugging port + throwaway profile), remembers the
endpoint and the desired viewport/UA in a state dir under the OS temp dir (never the repo), and
re-attaches on each command. `driver stop` (or `quit`) tears that shared browser down cleanly.

**Want your own driver instead?** Set `BROWSER_DRIVER` to any CLI that honors the contract above — a
thin wrapper over Playwright, Puppeteer, or another CDP client all work. An explicit `BROWSER_DRIVER`
always overrides the bundled one.

### `driver doctor` — check the browser (and guided install)

Run `agents/ui-evaluator/driver/browser-driver doctor` to see what the driver found. If a browser is
present it prints the path and exits `0`; `capture.sh` runs this as a preflight, so a missing browser
surfaces a friendly, copy-pasteable message instead of a mid-capture failure. If none is found:

- **macOS:** it suggests `brew install --cask chromium`. Pass `--install` (or answer the `y/N` prompt
  on a TTY) to have it run that for you — it **never** installs anything without your explicit consent.
- **Linux:** it prints the distro-appropriate hint (`apt-get` / `dnf` / `pacman` / `zypper`).

### `AGIX_BROWSER_BIN` — pin a specific browser

Auto-detection covers the common macOS `.app` paths and the usual Linux binaries on `PATH`. To force a
specific one, set `AGIX_BROWSER_BIN` to its executable path, e.g.
`export AGIX_BROWSER_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.

## Auth seam (routes behind a login)

Signing in is **the caller's responsibility**, kept out of this agent on purpose. If your routes are
public, skip this. If they are behind a login, hand the driver an **already-authenticated session**
before capturing — either sign in once in the driver's browser and persist the context, or inject
whatever session token your app uses (a cookie, or a `localStorage` value) via the driver's `eval`.
This agent does not carry app credentials and mints no sessions; it only navigates and captures. Use a
dedicated low-privilege evaluation account, never a privileged one, and keep any secret out of the
repo.

## Configuration

| Config | Required | Meaning |
|---|---|---|
| `BASE_URL` | yes | origin under test, e.g. `https://app.example.com` |
| `BROWSER_DRIVER` | no | override the bundled driver with your own CLI (see the contract above) |
| `AGIX_BROWSER_BIN` | no | pin a specific Chromium-family browser binary for the bundled driver |
| `ANTHROPIC_API_KEY` | yes | powers the vision judge |
| `ROUTES_MOBILE` / `ROUTES_DESKTOP` | no | space-separated route lists to override the defaults |

## Run the capture

```
export BASE_URL=https://app.example.com
# BROWSER_DRIVER is optional — unset, capture.sh uses the bundled driver/browser-driver.
# Bring your own with:  export BROWSER_DRIVER=/path/to/your/browser-driver

bash agents/ui-evaluator/capture.sh mobile  "$BASE_URL"
bash agents/ui-evaluator/capture.sh desktop "$BASE_URL" "" / /pricing /login
ROUTES_MOBILE="/ /pricing /signup" bash agents/ui-evaluator/capture.sh mobile "$BASE_URL"
```

Output: `agents/ui-evaluator/runs/<profile>-<timestamp>/` with `<device>_<route>.png`,
`.metrics.json`, and `.console.txt` per capture. The agent then judges those bundles and writes
`wiki/ui-evaluator/reports/<date>.md`.

## What it checks

**Deterministic (the gate — `probe.js`):** horizontal overflow, tap targets < 44px, inputs < 16px
(iOS auto-zoom), `viewport-fit=cover`, interactive-element counts, console errors. Exact, cheap,
regression-stable. These metrics are ground truth; the judge never re-measures or overrides them.

**Vision judge (the gray area):** visual hierarchy, cramped / truncated / overlapping content,
thumb-reachability of the primary action, cross-device consistency, and generic AI-slop polish —
scores 0-10 and ranks issues P0-P3. It never overrides a deterministic hard-fail; it explains + ranks.

## Device profiles

| Profile | Devices (width x height @ DPR) |
|---|---|
| `mobile` | iPhone 15 393x852@3 · iPhone SE 375x667@2 · Pixel 8 412x915@3 · Galaxy S 360x800@3 · iPad mini 768x1024@2 |
| `desktop` | laptop 1280x800 · desktop 1440x900 · wide 1920x1080 |

A per-device UA (iOS / Android / desktop) is set so UA-conditional code runs.

## Report shape

1. A one-paragraph verdict + overall average score (mean of the route scores).
2. **Top fixes** — the P0/P1 issues ranked by severity then reach (how many routes/devices they hit,
   deduped, "(N routes)").
3. A per-route score table (route | score | #P0 | #P1).
4. A one-line caveat that this is headless device-emulation, not real-Safari / Chrome-Android fidelity.

## Caveat (fidelity)

The driver is **a headless browser emulating a device** — excellent for layout / overflow / tap-size /
font-size / console / hierarchy, but **not** an iOS-Safari or Chrome-Android rendering oracle
(Safari-only quirks: momentum scroll, `position:fixed`, `100vh`, input-zoom physics). True per-engine
fidelity needs a real device cloud (e.g. a hosted device farm). Treat this as a **layout + usability +
a11y** harness.

## Trust posture

Proposer. This agent reads, captures, measures, and reports. It **does not edit the source it
evaluates** — actor is not verifier. Another agent repairs the UI; this one re-runs and reports the
score delta.
