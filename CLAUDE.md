# CLAUDE.md

This file is instructions for you, Claude Code, working on this project. Read
`BUILD_SPEC.md` first for what we're building. This file is about *how* to
work: hackathon-specific development discipline, and how to talk to me.

The person you're working with is a solo developer, 32 hours, no sleep budget
to waste, building a Roblox × Shopify AI commerce experimentation platform.
Every rule below exists because it either saves time or prevents a demo-day
disaster. If a rule and a "better" idea conflict, the rule wins unless I say
otherwise.

---

## 1. The one question that governs every decision

> Does this make **Observe → Understand → Change → Test** more reliably
> demonstrable?

If yes, do it. If it's just technically nice, it's a stretch goal — say so
and ask before spending time on it. Don't silently gold-plate anything.

---

## 2. Hackathon development practices

### Speed over elegance, but not speed over correctness on the critical path

- The critical path is: telemetry → backend → dashboard → AI plan → MCP apply
  → visible change in Studio. Code on that path should be simple and boring,
  not clever. Prefer the obvious solution that works over the elegant one
  that might not.
- Everything *not* on the critical path (styling, extra metrics, nice-to-have
  visualizations) can be rough. Don't spend equal care everywhere.
- No premature abstraction. Don't build a plugin system, a generic event bus,
  or a config-driven anything unless the spec asks for it. Write the specific
  code for the specific thing.

### Working software beats planned software

- After any meaningful chunk of work, run it. Don't write five files and
  then discover the first one was wrong.
- Prefer vertical slices: get one product's telemetry flowing end-to-end
  before building out all five. Get one MCP operation working before
  building all eight.
- If something is going to take more than ~45 minutes and isn't unblocking
  anything else, stop and flag it rather than disappearing into it.

### No silent scope creep

- Don't add features, config options, tests, or "while I was in there"
  refactors that aren't in `BUILD_SPEC.md` or that I didn't ask for. Propose
  them as a one-line suggestion instead, and wait.
- Don't touch `Workspace` via Rojo. Don't add OAuth. Don't build the 3D
  visualization in the web app (it's Roblox — use `screen_capture`). These
  are explicit non-goals in the spec; treat them as tripwires, not
  suggestions.

### Fail loud, fail fast, fail safe

- Any network call (Roblox → backend, backend → Shopify, backend → LLM,
  Bridge → MCP) gets wrapped in error handling that can't crash the caller.
  A dead backend must never break the Roblox game during a demo.
- When something fails, the failure should be visible in logs or the UI, not
  swallowed. Silent failures are the thing most likely to blow up on stage.
- Anything that touches the live Roblox place (via MCP) takes a snapshot
  first. Every apply must be reversible in one call. This is non-negotiable,
  not a nice-to-have — say so if you're ever asked to skip it.

### Checkpoints, not silent marathons

- After finishing each numbered phase in the spec's schedule (section 14),
  stop and give me a short status: what works, what you verified it by
  (a command, a screenshot, a curl), and what's next. Don't chain phases
  together without checking in.
- Before starting anything Tier 2 or Tier 3, confirm Tier 1 for that piece
  actually works end-to-end. Don't build the heatmap before the events
  reaching the database are confirmed correct.

### Protect the fallback ladder

- The moment the full MCP loop (dashboard → Bridge → Studio) works even
  once, tell me immediately so I can record it. Don't wait for it to be
  polished.
- Build Fallback 2 (a Studio plugin button that reads a plan file) by the
  time the spec says to, regardless of whether the full path is working.
  It's cheap insurance — treat it as required, not optional.

### Committing and versioning

- Commit at every working checkpoint, not at the end of a phase. A commit
  that doesn't compile or run is not a checkpoint.
- Write commit messages that describe what now works, e.g. "telemetry:
  proximity + gaze events reach backend", not "wip" or "updates".
- Never commit `.env.local`, Shopify tokens, or LLM API keys. Check
  `.gitignore` covers them before the first commit that touches secrets.

### Data and demo hygiene

- Keep the synthetic-data simulator (`scripts/simulate.ts`) clearly separate
  from real event ingestion. Never let simulated events silently mix into a
  "live" demo view without a visible label.
- Any number shown on the dashboard should be traceable to either "seeded
  simulation" or "live session" — don't present one as the other.

---

## 3. How to communicate with me

I want every response to be something I can read once, at speed, under
fatigue, and immediately know what happened and what to do next. Optimize
for that, every single time, no exceptions for "small" updates.

### Plain language, no jargon-without-definition

- Use plain, everyday words. If a technical term is genuinely necessary
  (e.g. "raycast", "webhook", "debounce"), define it in the same sentence,
  briefly, the first time you use it in a given response.
- Avoid stacking qualifiers and hedges. Say what happened, plainly.
- No filler ("I've gone ahead and...", "Great question!", "As you can
  see..."). Start with the information.

### Lead with the state of the world, not the process

- Every response about a task should open with: **did it work, yes or no**,
  in the first sentence. Then the detail. Don't make me read five paragraphs
  to find out if something is broken.
- If you ran something to verify (a curl, a test event, a screenshot), say
  what you ran and what came back — don't just assert "it works."

### Structure for scanning, not for reading straight through

- Use short paragraphs or a short list. Avoid long unbroken prose blocks.
- When reporting on multiple things (e.g. the setup checks), use a table or
  a clearly labeled list — pass/fail per item, not a narrative that buries
  the failures in the middle.
- Bold the one or two words that matter most in a status update (what
  failed, what's blocked) so it can be spotted without reading every word.

### Every technical claim should be checkable

- If you say "events are reaching the backend," show the command or query
  that proves it, not just the claim.
- If you're not sure something works, say "untested" or "I haven't verified
  this yet" — don't imply confidence you don't have. A wrong "this works" at
  hour 27 costs more than an honest "not sure" at hour 10.

### When something is broken or blocked

- Say what's broken, in one sentence, first.
- Say what you think the cause is, and how sure you are.
- Say what you need from me (a decision, a credential, a manual step in
  Studio/Shopify) — separate clearly from what you're going to do yourself.
- If there's a workaround that keeps the demo alive (see the fallback
  ladder in the spec), name it, even if you haven't built it yet.

### When proposing something not in the spec

- One sentence: what it is, why it'd help, roughly how long it'd take.
  Then stop and wait — don't build it speculatively.

### No hype, no apologizing, no editorializing

- Don't describe your own work as "robust", "production-ready", or
  "comprehensive." Let the checks speak. This is a hackathon project; call
  it what it is.
- Don't over-apologize for bugs. Fix, report, move on.

---

## 4. Quick self-check before sending any response

1. Does the first sentence tell me the outcome?
2. Would this make sense to someone reading it half-asleep at 4am?
3. Is every claim backed by something I could re-run myself?
4. Did I avoid adding anything not asked for?
5. Is there a term I used without explaining it?

If any answer is "no," fix it before sending.
