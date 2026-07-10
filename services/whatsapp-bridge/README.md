# whatsapp-bridge

An **optional**, reproducible two-way WhatsApp **control plane** for the Agix
AOS. Text the server from your phone; an agent handles the message; the reply
comes back over WhatsApp.

It drives **WhatsApp Web** headlessly via the
[`whatsapp-web.js`](https://wwebjs.dev/) library. This is the most seamless,
reproducible-from-a-fresh-download lane: **no** Meta business account, **no**
Twilio, **no** public webhook or tunnel. Install two deps, run, scan a QR
once, done.

---

## One-time setup (fresh Agix-AOS download)

1. **Install the two new dependencies** (the only deps this module adds):

   ```bash
   # This repo is a pnpm workspace and the bridge has no package.json of
   # its own (it runs under the root and imports ../../lib), so the deps go
   # on the workspace ROOT — the -w flag is required or pnpm refuses.
   pnpm add -w whatsapp-web.js qrcode-terminal
   ```

   > `whatsapp-web.js` pulls in **`puppeteer-core`** transitively to drive
   > WhatsApp Web. `qrcode-terminal` renders the pairing QR in your terminal.
   >
   > ⚠ **Browser:** `puppeteer-core` ships **no** Chrome of its own. Either
   > install puppeteer's pinned build once —
   > `npx @puppeteer/browsers install chrome@stable` — **or** point the
   > bridge at a Chrome/Chromium/Edge you already have via `chromePath`
   > (below) or the `PUPPETEER_EXECUTABLE_PATH` env var.

2. **Create your config** from the example and set your allowlist:

   ```bash
   cp services/whatsapp-bridge/config.example.json services/whatsapp-bridge/config.json
   ```

   Edit `config.json`:

   | key             | meaning                                                                                          |
   | --------------- | ------------------------------------------------------------------------------------------------ |
   | `allowlist`     | Array of E.164 numbers allowed to command the server (digits, any formatting; `+`/spaces ok).    |
   | `authDir`       | Local, gitignored dir for the WhatsApp session (default `.wwebjs_auth`).                          |
   | `commandPrefix` | Optional. If set (e.g. `"!"`), only messages starting with it are dispatched. Empty = all.        |
   | `chromePath`    | Optional. Absolute path to a Chrome/Chromium/Edge binary for puppeteer-core. Empty = use puppeteer's own / `PUPPETEER_EXECUTABLE_PATH`. |

   (JSON can't hold comments — this table is the comment.)

   `config.json` is **gitignored**; only `config.example.json` is committed.

---

## Run

```bash
node services/whatsapp-bridge/index.mjs
```

On first run a **QR code** prints in the terminal. On the phone whose number
will operate the server:

> WhatsApp → **Settings** → **Linked Devices** → **Link a Device** → scan the QR.

The session is then persisted in `authDir` (gitignored), so subsequent runs
start without a re-scan. Send `help` from an allowlisted number to confirm the
round trip.

---

## How agent control works

The bridge's single seam to the AOS is one function in `index.mjs`:

```js
export async function handleMessage({ from, text }) -> Promise<string>
```

It returns the text to reply with. The default implementation handles two
built-in commands and falls through to the Agix runtime:

- `help` — list commands.
- `status` — a short server status line.
- **anything else** — sent to the runtime's model dispatcher
  (`runtime.getModel().chat(...)` from `lib/agix-runtime.mjs`) for a reply, so
  a fresh install answers free-text out of the box.

**Wiring to a specific agent** is a one-function change. Every agent runs
through the runtime's `runAgent(name, opts)` dispatcher (see
`lib/agix-runtime.mjs`). Swap the `model.chat(...)` block in `handleMessage`
for:

```js
import { runAgent } from '../../lib/agix-runtime.mjs';
const result = await runAgent('<agent-name>', { message: text, /* … */ });
return result.reply; // whatever that agent returns
```

The seam is marked with a `TODO(agent-wiring)` comment in `index.mjs`.

---

## Security model — the allowlist

Only numbers in `config.json`'s `allowlist` can command the server. Both the
inbound sender id and the allowlist entries are **normalized to bare digits**
before comparison, so formatting never causes a false reject. A non-allowlisted
message is **logged and silently ignored** — it gets no reply, so an unknown
sender gets no signal the bridge even exists. An empty allowlist ignores
everyone (and logs a startup warning).

Handler errors are wrapped: one bad message can never crash the bridge.

---

## Privacy / local-only stance

The WhatsApp session and credentials live **only** on your machine, under the
gitignored `authDir` (`whatsapp-web.js` `LocalAuth`). They are **never**
committed and never sent anywhere. `config.json` (your allowlist) is gitignored
too. The module adds nothing to the repo's network surface beyond WhatsApp Web
itself.

---

## ⚠ ToS / ban caveat — read before client use

Automating a **personal** WhatsApp number is **against WhatsApp's Terms of
Service** and carries a real **ban risk**. To stay sane:

- Use a **dedicated or secondary** number, not your personal one.
- Keep volume **low and human-like**. This is an operator control channel, not
  a broadcast tool.

For anything **client-facing or high-volume**, graduate to the official
[**WhatsApp Business Cloud API**](https://developers.facebook.com/docs/whatsapp/cloud-api/)
(Meta-sanctioned, no ban risk, but requires a Business account + approved
templates + a public webhook). The `handleMessage` seam means the agent logic
is identical across both transports — only the bridge changes.

---

## Reproducibility

What a new machine needs to enable this module, end to end:

1. **Node** (the repo already requires `node >=20.11.0`).
2. **Two deps:** `pnpm add whatsapp-web.js qrcode-terminal`.
3. **One QR scan** (interactive, once).

What stays **local and uncommitted** (never travels with the repo):

- `.wwebjs_auth/` — the WhatsApp session + credentials.
- `config.json` — your allowlist and paths.
- `.wwebjs_cache/` and any browser/session artifacts.

Everything else (`index.mjs`, `config.example.json`, `.gitignore`, this README)
is committed and identical on every checkout.
