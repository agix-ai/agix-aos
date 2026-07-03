# AI Contribution Policy

Agix AOS is an operating system for a team of AI agents. Contributions authored
with the help of AI agents are **welcome** here — they're a feature of this
project, not an exception to it. We build Agix with Agix. What we ask is that the
work stays legible and accountable.

## The rules

**1. Disclose provenance.** If an AI agent wrote or substantially shaped a
commit, say so with a commit trailer:

```
Co-Authored-By: <Agent name> <noreply@example.com>
```

Use the trailer the agent's tooling emits (for example a `Co-Authored-By` line).
The goal is an honest record of who — human and machine — produced the change.

**2. A human stays accountable.** Every pull request has a human author who
**understands the change and can defend it**: what it does, why it's correct, and
what it might break. "The agent wrote it" is never an answer to a review comment.
If you can't explain a line, don't ship it.

**3. Same gates, no exceptions.** Agent-authored changes clear exactly the same
bar as human-authored ones:

- `agix agent eval --all` is green.
- The public-clean gate passes on anything public-bound.
- The change is scoped, reviewed, and DCO-signed (`git commit -s`).

We don't hold agent contributions to a lower standard, and we don't hold them to
a higher one. The gate is the gate.

## Why this is permissive

Some projects ban autonomous-agent contributions outright. We take the opposite
view: agents that produce reviewable, tested, disclosed work make the project
better, and dogfooding them is how Agix earns its keep. The risk isn't that an
agent wrote the code — it's un-owned, un-reviewed code, whoever wrote it. This
policy targets that, and welcomes the rest.
