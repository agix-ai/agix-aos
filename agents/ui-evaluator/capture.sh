#!/usr/bin/env bash
# UI-eval capture — drives a web app at a device PROFILE through a pluggable
# headless-browser driver and captures, per route x device: a screenshot, the
# deterministic metrics (probe.js), and console errors. The agent's vision judge
# then hands each {screenshot + metrics} bundle to a vision model (see README.md).
#
# BROWSER DRIVER (pluggable, with a bundled default): $BROWSER_DRIVER is a CLI
# that speaks this small command contract (the harness shells out to it, nothing
# more):
#
#   "$BROWSER_DRIVER" viewport   <WxH> --scale <n>   # set device size + DPR
#   "$BROWSER_DRIVER" useragent  <ua-string>          # set the user-agent
#   "$BROWSER_DRIVER" goto       <url>                 # navigate
#   "$BROWSER_DRIVER" wait       --networkidle         # wait for the page to settle
#   "$BROWSER_DRIVER" eval       <script-file>         # run a JS file in the page, print its return
#   "$BROWSER_DRIVER" console    --errors              # print captured console errors
#   "$BROWSER_DRIVER" screenshot <out.png>             # write a full-page screenshot
#
# If $BROWSER_DRIVER is UNSET, we default to the bundled reference driver next to
# this script (driver/browser-driver): a zero-dependency CDP driver that drives a
# Chromium-family browser the user already has. Set $BROWSER_DRIVER to override
# with your own (a thin Playwright/Puppeteer/CDP wrapper that honors the contract).
# See README.md ("Prerequisite: a browser-driver substrate") and `driver/ doctor`.
#
# NOTE: a headless browser EMULATING a device is great for layout / overflow /
# tap-target / font-size / console / hierarchy; it is NOT an iOS-Safari or
# Chrome-Android rendering oracle. Real per-engine fidelity needs a device cloud.
# We set a per-device UA (iOS / Android / desktop) so UA-conditional code still runs.
#
# AUTH: routes behind a login are the caller's responsibility. The driver must be
# handed an already-authenticated session before this runs (see README "Auth seam");
# this harness only navigates and captures, it does not sign anyone in.
#
# Usage: capture.sh <mobile|desktop> [BASE_URL] [RUN_DIR] [route ...]
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Default to the bundled reference driver (resolved next to this script) so the
# agent is plug-and-play; an explicit $BROWSER_DRIVER still overrides it.
B="${BROWSER_DRIVER:-$HERE/driver/browser-driver}"
if [ ! -x "$B" ] && ! command -v "$B" >/dev/null 2>&1; then
  echo "capture: BROWSER_DRIVER '$B' is not an executable CLI (see README 'Prerequisite: a browser-driver substrate')" >&2
  exit 3
fi

# Preflight: confirm a usable browser is present. doctor prints a friendly,
# copy-pasteable guided-setup message (and exits non-zero) when none is found,
# so an operator sees guidance instead of a cryptic failure mid-capture.
if ! "$B" doctor >&2; then
  echo "capture: no usable browser for the driver — see the guided-setup message above." >&2
  exit 3
fi
PROFILE="${1:-mobile}"
BASE="${2:-${BASE_URL:-https://app.example.com}}"
RUN="${3:-$HERE/runs/${PROFILE}-$(date +%Y%m%d-%H%M%S)}"
shift 3 2>/dev/null || true
ROUTES=("$@")

# Optional: override the default route lists without editing this file.
#   ROUTES_MOBILE="/ /pricing /login"  ROUTES_DESKTOP="/ /features"
UA_IOS="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
UA_ANDROID="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
UA_DESKTOP="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

# device := name:WxH:scale:platform   (platform -> UA; most drivers cap --scale at 3)
case "$PROFILE" in
  mobile)
    DEVICES=(
      "iphone15:393x852:3:ios"      # iPhone 15 / 14 Pro — modern iOS baseline
      "iphonese:375x667:2:ios"      # iPhone SE — small-iOS worst case
      "pixel8:412x915:3:android"    # Pixel 8 — large Android
      "galaxys:360x800:3:android"   # Galaxy S — narrow Android worst case
      "ipadmini:768x1024:2:ios"     # iPad mini portrait — small tablet
    )
    if [ ${#ROUTES[@]} -eq 0 ]; then
      # shellcheck disable=SC2206
      ROUTES=(${ROUTES_MOBILE:-/})
    fi
    ;;
  desktop)
    DEVICES=(
      "laptop:1280x800:2:desktop"   # small laptop
      "desktop:1440x900:2:desktop"  # common desktop
      "wide:1920x1080:1:desktop"    # wide monitor
    )
    if [ ${#ROUTES[@]} -eq 0 ]; then
      # shellcheck disable=SC2206
      ROUTES=(${ROUTES_DESKTOP:-/})
    fi
    ;;
  *)
    echo "unknown profile '$PROFILE' (use: mobile | desktop)" >&2
    exit 2
    ;;
esac

mkdir -p "$RUN"
echo "profile=$PROFILE base=$BASE run=$RUN routes=${#ROUTES[@]} devices=${#DEVICES[@]}"

for d in "${DEVICES[@]}"; do
  IFS=: read -r dn dvp ds dplat <<<"$d"
  case "$dplat" in
    ios) ua="$UA_IOS" ;;
    android) ua="$UA_ANDROID" ;;
    *) ua="$UA_DESKTOP" ;;
  esac
  "$B" viewport "$dvp" --scale "$ds" >/dev/null 2>&1
  "$B" useragent "$ua" >/dev/null 2>&1
  for r in "${ROUTES[@]}"; do
    slug="${dn}_$(echo "$r" | sed 's#/#_#g; s#^_##')"
    [ -z "$slug" ] && slug="${dn}_root"
    "$B" goto "$BASE$r" >/dev/null 2>&1
    "$B" wait --networkidle >/dev/null 2>&1 || sleep 2
    # networkidle means the network is quiet; it does not mean the UI has finished
    # painting. Screenshotting into a running fade-in captures a half-drawn page and
    # the vision judge then reports failures that do not exist. Freeze animation and
    # fire any scroll-reveal observers before we look at it.
    "$B" eval "$HERE/settle.js" >/dev/null 2>&1
    "$B" eval "$HERE/probe.js" >"$RUN/$slug.metrics.json" 2>/dev/null
    "$B" eval "$HERE/probe-contrast.js" >"$RUN/$slug.contrast.json" 2>/dev/null
    "$B" console --errors >"$RUN/$slug.console.txt" 2>/dev/null
    "$B" screenshot "$RUN/$slug.png" >/dev/null 2>&1
    echo "  captured $slug  ($dvp $dplat)"
  done
done

echo "RUN=$RUN"
