<p align="right">
  <strong>English</strong> · <a href="./README_ZH.md">简体中文</a>
</p>

# dsh-auto-review-ww

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x%2B-202724)

**Sandbox-first Auto Review for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
Routine work runs unreviewed inside the real `workspace-write` sandbox; only an escalation
beyond the workspace pays for one LLM review. Fully unattended: the reviewer never falls
back to a human, and every refusal carries its reason back to the requesting agent.

```text
any tool call
  ├─ fits the workspace-write sandbox?  → runs, zero review, zero tokens
  └─ asks for a wider sandbox           → one escalation review
        low    → allowed
        medium → judged on substance (task fit, effects, reversibility)
        high   → denied
        reviewer failure → fail closed, reason published to the agent
```

> [!IMPORTANT]
> **Keep the shipped `@deepseek-ai/dsh-experimental-auto-review` row enabled.**
> `auto` is a reserved preset id that only the official row provides at runtime, and
> sessions whose last `permission/preset` event is `auto` cannot cold-open without it.
> This plugin coexists with the official row: the official row owns the reserved `auto`
> state, this package owns the `auto-review` preset and its reviewer, and neither
> registers the other's identity.

## Why not the official Auto review?

The shipped experimental Auto review runs on a `danger-full-access` base and its review
is part of every request. This plugin takes the opposite trade:

| | Official Auto review | dsh-auto-review-ww |
| --- | --- | --- |
| Sandbox base | `danger-full-access` (no sandbox) | `workspace-write` (real sandbox) |
| Review trigger | every command | escalation-only |
| Token overhead | one review per request | **0** for in-sandbox work; one trimmed snapshot per escalation |
| Unattended one-shot runs | yes, but everything runs unsandboxed | yes, and risky actions still meet a reviewer |
| Reviewer failure | fails the request | fail closed, **reason published to the agent** |
| Preset source | reserved `auto` (official row) | plain row config `auto-review`, no private constants |
| Upgrade resilience | tied to the official row | nothing touches host private constants; a plugin crash leaves the preset selectable (degrades to human approval) |

Typical fit: you want one-shot autonomous completion, you are unwilling to hand out
`danger-full-access`, and you do not want a human approval step in the middle.

## Install

In Harness, open **Plugins → Add plugin** and enter either:

```text
dsh-auto-review-ww
https://github.com/Andy-Xie-1145/dsh-auto-review-ww
```

or, for a Web profile:

```sh
dsh plugin --profile web add github:Andy-Xie-1145/dsh-auto-review-ww
```

Then fully restart Harness and pick the **Auto review** preset (plain entry — the client
only decorates the official `auto` value). Works with any model route; the reviewer rides
the session's own provider and model.

## How the reviewer decides

Each escalation sends a five-section snapshot to the session's own provider and model:

| Section | Contents |
| --- | --- |
| `REVIEW_POLICY` | fixed judgment policy |
| `ENVIRONMENT` | session `cwd` |
| `PROJECT_INSTRUCTIONS` | project-level constraint texts |
| `FILTERED_HISTORY` | role-tagged history: human instructions, parent instructions, checkpoints, facts (executed tool calls with their arguments, question-card answers) |
| `PENDING_ACTION` | the exact escalated call: tool name, full arguments, tool schema, approval reason |

The policy asks one question — *should this call run now, given everything visible in
this session?* — and answers with the closed JSON protocol
`{"risk":"low|medium|high","decision":"allow|deny","reason":"..."}`. Concretely:

- an action the session's task plainly needs does not require a separate blessing,
- an authorized action that should not run is still denied,
- a mismatch between claimed purpose and real effects denies,
- unknown or unrelated effects fail closed.

Denial reasons travel back on a dedicated channel: an append-only context block whose
text is byte-stable for identical refusals, so repeated denials cost nothing extra and
never invalidate the prompt cache. Reviewer failures publish a stable explanation too
("reviewer outage, not a risk verdict") instead of refusing silently.

## Verdict reuse, review timeout, and raw-output logging

- **Verdict reuse:** an identical escalation (same session, tool and justification)
  inside the reuse window returns the reviewed outcome without another model call —
  retry loops and repeated maintenance commands pay once. Window:
  `AUTO_REVIEW_WW_VERDICT_TTL_MS` (default 30 minutes).
- **Review timeout:** a single review is hard-capped
  (`AUTO_REVIEW_WW_REVIEW_TIMEOUT_MS`, default 120 s). On timeout the escalation fails
  closed with a published reason instead of blocking the turn for minutes.
- **Raw-output logging:** every review logs its route, payload size and the model's
  verbatim output (plus a reasoning head) to the host console
  (`reviewer route <provider>/<model> payload=... raw output ...`), so "did it actually
  call the model?" is always answerable from logs. Set
  `AUTO_REVIEW_WW_DEBUG_LOG=<file>` for a complete evidence file.
## Compatibility notes

- Declared host range: `0.2.0-rc.2 || >=0.2.1-rc.0 <0.4.0-0` (covers 0.2.0-rc.2, every 0.2.1-rc+/release through 0.2.5+ and the 0.3 line; validated with node-semver in both strict and includePrerelease modes).`n  The plugin declares no private host constants and no host imports, so any host that`n  keeps the permission-row config shape works; run `node selftest.mjs` after upgrading.`n  The optional sandbox patch self-guards by exact line match and refuses to patch a`n  changed host.
- The official `@deepseek-ai/dsh-experimental-auto-review` row stays **enabled**. Two
  preset entries appear in the picker: the official `auto` (with the EXP badge) and this
  package's `auto-review` (plain entry — the client only decorates `auto`).
- Zero runtime dependencies: all host helpers are inlined, so `link:`/junction installs
  resolve cleanly.

## Optional: denial reason in the tool return (experimental host patch)

The host composes an escalation rejection inside `@deepseek-ai/dsh-sandbox` with a
fixed template ("the user rejected escalating this ...") and the approval protocol
carries no reason field, so a plugin cannot alter that text on its own. This repo
therefore ships an optional, single-line host patch:

```sh
node tools/patch-sandbox-rejection.mjs            # apply (idempotent)
node tools/patch-sandbox-rejection.mjs --revert   # restore the stock line
```

When patched, a rejection made by this reviewer reads:

```text
the Auto Reviewer denied escalating this <subject> to "<mode>": <reason> ...
```

Unpatched hosts are unaffected (the registry is simply never read), unattended
semantics are unchanged, and the patch must be re-applied after each Harness
upgrade. Without the patch the reason still reaches the agent through the
context channel.
## Production lessons (each one is a regression test)

1. **Never freeze an `AbortSignal`.** `deepFreeze(options)` used to freeze the composed
   signal; downstream `AbortSignal.any()` then threw
   `Cannot add property Symbol(kDependantSignals), object is not extensible`, and every
   review died in single-digit milliseconds.
2. **Do not force `temperature: 0`.** Some `openai-responses` relays reject it with an
   opaque upstream failure while the same route serves agent-loop traffic happily.
3. **Reviewer failures must publish a reason.** A silent fail-closed reject is
   undebuggable; the failure branch publishes a stable "reviewer outage" explanation and
   the exact upstream error stays on the host log.
4. **Question-card answers are human instructions.** They arrive as tool results, so
   `retainedContext` retains them with the `human-instruction` role — a decision made in
   a card counts as much as a typed one.
5. **Never disable the official auto-review row.** `auto` is reserved; sessions persisted
   on `auto` fail to cold-open without its provider, and the UI shows them permanently
   unavailable.

## Self-test

```sh
node selftest.mjs
```

Thirty checks cover decision mapping, escalation gating, signal integrity, card-answer
retention, reason publication, fail-closed behavior, and unload semantics.

## License

[MIT](./LICENSE)
