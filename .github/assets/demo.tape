# Agix AOS — terminal demo recording (vhs by Charm).
#
# A self-narrating ~22s demo of REAL usage: see the fleet, call an agent, fan a task across a
# governed swarm, and watch it pause at the actor≠verifier gate. Each step is captioned (a shell
# # comment, ignored by bash but visible). All $0 (mock), deterministic.
#
#   brew install vhs
#   vhs .github/assets/demo.tape   # run from the repo root  ->  .github/assets/agix-demo.gif
#
# Pacing knobs: TypingSpeed + the Sleep after each Enter.

Output .github/assets/agix-demo.gif

Require agix

Set Shell bash
Set FontSize 16
Set Width 1200
Set Height 760
Set Padding 22
Set TypingSpeed 22ms
Set Theme "Catppuccin Mocha"

Hide
Type "clear"
Enter
Sleep 300ms
Show

# open on the honeycomb banner — meet the hive
Type "# meet the hive — a team of AI agents you own"
Enter
Sleep 700ms
Type "agix version"
Enter
Sleep 1.9s

# a whole fleet, installed with one CLI
Type "# a whole fleet, installed with the CLI — no API key"
Enter
Sleep 900ms
Type "agix agent list | head -8"
Enter
Sleep 2.1s

# name a problem, an agent takes it ($0 mock dry-run)
Type "# call any agent on a task  (mock = $0, deterministic dry run)"
Enter
Sleep 900ms
Type `agix agent run investigator "login fails after the session refactor" --provider mock`
Enter
Sleep 2.3s

# or fan one task across a governed swarm — actor != verifier, $0
Type "# or fan one task across a governed swarm — the worker never verifies itself"
Enter
Sleep 900ms
Type `agix hive "review the auth module for bugs" --provider mock | grep -E '^(task|subtasks|verifier|cost|ledger):'`
Enter
Sleep 2.3s

# governed: it pauses at the actor != verifier gate for your verdict
Type "# and it pauses at the actor != verifier gate for your verdict"
Enter
Sleep 900ms
Type `agix flow "add a login page" --gate=approve | head -4`
Enter
Sleep 2.4s

Sleep 1s
