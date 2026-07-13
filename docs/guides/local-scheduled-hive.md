# Run your own scheduled local agent hive

Set up a fleet of Agix agents that do real work on a **local model**, on a **schedule**,
at **$0** — nothing leaves your machine.

This guide walks you from a clean install to a hive of agents that wake up on a cadence
(say, every weekday evening), each running on your own local model, each producing a
governed, auditable receipt. No cloud provider, no API bill, no telemetry.

> **The idea:** an agent is a manifest you can run on demand. Point it at a local model
> and let your OS scheduler fire it on a cadence, and you have a self-running hive that
> compounds knowledge while you sleep — for free.

---

## 1. Prerequisites

### Install Agix

```sh
brew install agix-ai/agix/agix-aos
```

Verify:

```sh
agix --version
```

### Install Ollama and pull a model

Agix's `local` provider talks to [Ollama](https://ollama.com). Install it, then pull any
model you like:

```sh
# install Ollama (macOS/Linux): see https://ollama.com/download
ollama pull qwen3.6:35b-a3b     # or any model you prefer
```

Bigger models reason better but run slower; smaller models are snappier. Pick what your
machine can host comfortably. Whatever you pull, remember its exact tag — you'll pass it
as `AGIX_LOCAL_MODEL`.

Keep Ollama running (it serves on `localhost:11434`). On macOS the menu-bar app handles
this; on Linux, `ollama serve` or the systemd unit.

### First-run onboarding

```sh
agix init
```

This provisions your instance — your agents directory, the knowledge fabric, and routing
defaults. Add `--defaults` to accept sensible defaults non-interactively.

---

## 2. Graduate work to local, $0

Agix routes each **capability** to a provider/model. The router resolves in this order:

```
per-capability overlay  >  --provider force  >  default table
```

The overlay is a surgical, per-capability override that **outranks** a whole-run
`--provider` force. So you can graduate a capability to your local model and it stays
local even when a run is otherwise pinned to a cloud provider.

The natural first capability to graduate is `cheap-classification` — high-volume, low-stakes
work that a local model handles fine:

```sh
agix route set cheap-classification local
```

See the full effective table:

```sh
agix route list
```

Capabilities you can route: `default-quality`, `cheap-classification`, `long-context`,
`tool-use-heavy`, `vision`. Graduate more as you gain confidence in your local model.

Remove an override any time:

```sh
agix route unset cheap-classification
```

---

## 3. Run an agent on the local model

The shape of a single run:

```sh
AGIX_LOCAL_MODEL=<model> agix agent run <name> "<task>" --provider local
```

For example:

```sh
AGIX_LOCAL_MODEL=qwen3.6:35b-a3b agix agent run research "Summarize this week's notes" --provider local
```

List the agents you have:

```sh
agix agent list
```

After a run, inspect the **governance receipt** — the actor→verifier→verdict trail, plus
cost and token totals:

```sh
agix artifacts
```

On a local run the cost line reads **$0**. The receipt shows a distinct verifier certified
the work (**actor ≠ verifier**, computed and displayed) — the same governance you'd get on
a cloud run, only free and private.

> **Honest note on latency:** a single governed run on a ~35B local model takes on the
> order of tens of seconds (longer for bigger models or bigger tasks). That's fine for a
> scheduled hive — it runs while you're away — but don't expect cloud-API snappiness.

---

## 4. Schedule it

Now hand the same command to your OS scheduler so it fires on a cadence. Pick your platform.

The pattern is identical everywhere:

- Run the **full path** to the `agix` binary (schedulers don't inherit your interactive shell's `PATH`).
- Set `PATH` to include where `agix` and its runtime (`bun`) live.
- Set `AGIX_LOCAL_MODEL`.
- Set the **working directory** to your project/repo root, so relative paths like `./agents` resolve.
- Capture stdout/stderr to a log file so you can debug.

Find your real binary paths first:

```sh
which agix      # e.g. /opt/homebrew/bin/agix  (macOS/Homebrew)
which bun       # e.g. /opt/homebrew/bin/bun
```

### macOS — launchd

Create `~/Library/LaunchAgents/com.example.agix-research.plist` (one file per agent —
copy and change the label, agent name, and log paths for each):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.agix-research</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/agix</string>
        <string>agent</string>
        <string>run</string>
        <string>research</string>
        <string>--provider</string>
        <string>local</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>AGIX_LOCAL_MODEL</key>
        <string>qwen3.6:35b-a3b</string>
    </dict>

    <key>WorkingDirectory</key>
    <string>/path/to/your/project</string>

    <key>RunAtLoad</key>
    <false/>

    <key>StartCalendarInterval</key>
    <array>
        <dict>
            <key>Weekday</key><integer>1</integer>
            <key>Hour</key><integer>18</integer>
            <key>Minute</key><integer>30</integer>
        </dict>
        <dict>
            <key>Weekday</key><integer>5</integer>
            <key>Hour</key><integer>18</integer>
            <key>Minute</key><integer>30</integer>
        </dict>
    </array>

    <key>StandardOutPath</key>
    <string>/tmp/agix-research.out.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/agix-research.err.log</string>
</dict>
</plist>
```

The example above fires Mondays and Fridays at 18:30. Add or drop `<dict>` entries in
`StartCalendarInterval` to change the cadence; omit `Weekday` to run every day.

Load it (and reload after edits):

```sh
launchctl unload ~/Library/LaunchAgents/com.example.agix-research.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/com.example.agix-research.plist
```

Trigger it once immediately to confirm it works:

```sh
launchctl start com.example.agix-research
```

**Two gotchas we hit — save yourself the debugging:**

1. **`PATH` must include where `agix` and `bun` live.** On Apple Silicon Homebrew that's
   `/opt/homebrew/bin`; on Intel it's `/usr/local/bin`. launchd starts with a bare `PATH`,
   so if you omit this the agent runtime won't be found and the job dies silently. Check
   the `StandardErrorPath` log if a run does nothing.
2. **Use the real binary path in `ProgramArguments`** — the actual `agix` from `which agix`,
   not a version-manager shim or a wrapper on a `PATH` that launchd doesn't have. Point
   straight at the binary.

### Linux — systemd timer (or cron)

**systemd** (per-user units, no root needed). Create
`~/.config/systemd/user/agix-research.service`:

```ini
[Unit]
Description=Agix research agent (local model)

[Service]
Type=oneshot
WorkingDirectory=/path/to/your/project
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=AGIX_LOCAL_MODEL=qwen3.6:35b-a3b
ExecStart=/usr/local/bin/agix agent run research --provider local
```

And `~/.config/systemd/user/agix-research.timer`:

```ini
[Unit]
Description=Run the Agix research agent on a cadence

[Timer]
# Mondays and Fridays at 18:30
OnCalendar=Mon,Fri 18:30
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now agix-research.timer
systemctl --user list-timers          # confirm the next fire time
journalctl --user -u agix-research     # read the run logs
```

(To keep user timers running when you're logged out: `loginctl enable-linger $USER`.)

**cron** alternative — `crontab -e`, then:

```cron
# Mon & Fri at 18:30 — note the explicit PATH and cd; cron has a minimal environment
30 18 * * 1,5 cd /path/to/your/project && PATH=/usr/local/bin:/usr/bin:/bin AGIX_LOCAL_MODEL=qwen3.6:35b-a3b /usr/local/bin/agix agent run research --provider local >> /tmp/agix-research.log 2>&1
```

### Windows — Task Scheduler (beta)

> Agix on Windows is **beta**. Expect rough edges.

Wrap the run in a small `agix-research.cmd` so environment and working directory are explicit:

```bat
@echo off
cd /d C:\path\to\your\project
set AGIX_LOCAL_MODEL=qwen3.6:35b-a3b
agix agent run research --provider local >> "%TEMP%\agix-research.log" 2>&1
```

Register it with `schtasks` (Mon & Fri at 18:30):

```bat
schtasks /Create /TN "Agix\research" /TR "C:\path\to\agix-research.cmd" /SC WEEKLY /D MON,FRI /ST 18:30 /F
```

Or via the GUI: **Task Scheduler → Create Task → Triggers** (weekly, Mon/Fri, 18:30) →
**Actions** (Start a program → your `.cmd`) → **General** (Run whether user is logged on
or not). Point the action at the full path of `agix.exe` (or the `.cmd` wrapper) and set
**Start in** to your project directory.

---

## 5. Why this is nice

- **$0.** The work runs on a model you host. A scheduled hive that fires nightly costs
  nothing beyond the electricity your machine already draws — `agix artifacts` shows the
  cost line at $0.
- **Private.** Nothing leaves the machine. No prompts, no outputs, no telemetry go to any
  cloud provider. The model, the knowledge fabric, and the receipts all live locally.
- **Governed.** Every scheduled run produces the same governance receipt as a cloud run:
  an actor→verifier→verdict trail with **actor ≠ verifier** computed and enforced. Audit
  any run with `agix artifacts` (or `agix artifacts <run-id> --html` for a shareable
  offline receipt). Unattended does not mean unaccountable.
- **It compounds.** Each run writes to the knowledge fabric, so tomorrow's runs stand on
  today's. A hive on a cadence gets more useful over time without more spend.

Scale the hive by dropping in one scheduler entry per agent, each pointing at a different
agent name and cadence.

---

## 6. Troubleshooting

- **Nothing happened when the job fired.** First stop: read the `StandardErrorPath` log
  (macOS), `journalctl --user -u <unit>` (systemd), or your redirected log file (cron /
  Windows). Silent failures are almost always a `PATH` or binary-path problem — see the
  two gotchas in the macOS section; they apply to every platform.
- **"model not found" / connection refused.** Ollama must be **running** when the job
  fires, and the model in `AGIX_LOCAL_MODEL` must already be pulled. Confirm with
  `ollama list` and `ollama ps`. If your machine sleeps, the scheduler may fire while
  Ollama isn't up yet — start Ollama at login, or pick a fire time when the machine is awake.
- **Work ran on the wrong provider.** Check the routing overlay with `agix route list`.
  Remember the precedence: a per-capability overlay outranks the run's `--provider`. If a
  capability is graduated to `local`, it stays local; if you expected local everywhere,
  confirm you passed `--provider local` and that no overlay is sending a capability elsewhere.
- **Relative paths (`./agents`) not found.** The scheduler's working directory isn't your
  project. Set it explicitly — `WorkingDirectory` (launchd/systemd) or `cd` (cron/Windows).
- **Runs feel slow.** Expected — a governed run on a large local model is tens of seconds.
  Use a smaller model for faster (lower-quality) runs, or lean into the schedule: let slow
  runs happen while you're away.
