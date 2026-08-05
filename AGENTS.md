# AGENTS.md — Chat Assistant (SillyTavern extension)

Operating notes for anyone (human or model) working in this repo. Read before touching `index.js`.

## The gate

```bash
node load_test.mjs     # exit 0 = safe to push. Non-zero = DO NOT PUSH.
```

There is no other gate and no partial credit.

- **`node --check index.js` is not a gate.** SillyTavern loads `index.js` as an **ES module**; `--check` on a `.js` file parses it as CommonJS and silently accepts things ESM rejects (a duplicate top-level `let`, most importantly). For a parse-only check, copy to a `.mjs` first: `cp index.js /tmp/ix.mjs && node --check /tmp/ix.mjs`.
- **A parse check proves nothing runs.** `load_test.mjs` really imports the module against a mocked SillyTavern, drives `init()` through `APP_READY`, clicks real buttons, and asserts behavior.
- **A guard that has never failed is unproven.** Every new guard must be negative-tested: reintroduce the bug in a scratch tree, run the gate, confirm it exits 1. Do this before claiming the guard works.
- **Measure, never predict.** Any count written into a test or a doc (character counts, call counts, window counts) is read off real output first.
- **A failing test needs a verdict:** is the TEST wrong or the CODE wrong? Say which, then fix that one.

## Release ritual

1. Fresh `git clone` into a numbered directory — never work from a possibly stale local copy.
2. `git ls-remote` before and after the push.
3. Bump **both** `const VERSION` in `index.js` and `version` in `manifest.json` — the gate fails if they disagree.
4. Three commits: `feat`/`fix` → `test` → `chore(release): vX.Y.Z`.
5. Changelog and architecture notes live in `README.md`; keep this file current with new invariants.
6. Remove scratch scripts (`fix*.py`, `add_*.py`) before committing. Never commit `node_modules` or `package-lock.json`.

## Invariants that must not regress

- **Message text is served whole, or it says it is not.** `fullTextOf()` is the only path from a chat message to the model, and `_formatMessage()` always stamps the exact character count plus `COMPLETE` or `PART n OF m … INCOMPLETE`. Any future size limit goes through the PART mechanism — a bare `.slice()` is the bug this whole subsystem exists to prevent, because a truncation the reader cannot detect produces confident wrong answers about where a message ends.
- **No silent short-serving anywhere.** Over-cap fetch ids are named back to the model, not dropped.
- **`msgServedWhole(id)` is the only definition of "has read it."** A part is not a read; the blind-edit guard must ask this rather than trust that a fetch happened.
- **Structure is decided in code, not by inference.** `scanMessageStructure` / `scanChatStructure` prove tag balance, duplicate blocks (by summary label), tails after the final closing tag, repeated long lines, and field-shape drift; the deep audit hands the results over as facts.
- **`ingestProposals(reply)` is the single path from a reply to staged cards.** Never inline a second copy.
- **`beginRun()` is the only place the run lock is taken and the only place `stopRequested` is cleared.** The gate counts the call sites; add an entrypoint and the count assertion must be updated deliberately.
- **Cross-chat contamination:** every LLM flow captures `chatRef()` at entry and checks `sameChat()` before writing anything.
- **`continuityCopilot` is the storage MODULE id.** Renaming it orphans every user's settings and per-chat data.
- **The deep audit sweeps VISIBLE messages only.** A ghosted message is already represented by a memory snippet; sweeping it linearly audits the same events twice and is what made a full run take an hour. Ghosted originals are pulled only where a pass states a doubt (`<verify>`), and a call budget pauses the run at a saved cursor rather than letting it run unbounded.
- **The memory is one ordered story, not a bag of entries.** Any pass that chunks it must ship `memorySpine()` with every chunk (or a contradiction between distant entries is unseeable), carry findings forward, and run the cross-section pass when there is more than one chunk. Chunk boundaries never fall inside an entry — the old character-count slice was the v2.72 truncation bug hiding in the memory path.
- **An anchor is a copy, not a description.** Every proposal is checked at arrival with the apply's own resolver (`locate` / `memLocateAny`, fuzzy floor included) so a flag is a guaranteed failure, never a false alarm; a bad one is corrected inside the same run. Blocks that carry clipped text (`[MESSAGE INDEX]`, `[MEMORY SPINE]`) must declare themselves unquotable in their own header — text that cannot be an anchor must say so where it is shown.
- **A pending card whose anchor is dead is retired by the next proposal for the same target.** Supersede must never require anchor *equality*: a corrected re-proposal carries a different anchor by definition. Gate retirement on `anchorIsDead`, never on target match alone, or still-valid independent fixes get silently dropped.
- **Chat-scoped state, not global.** Director, hidden ledger, session history, and the deep-audit resume cursor all live in `chatMetadata.continuityCopilot`.
- **Undo is refusal-first and node-scoped**: backups and drift fingerprints are taken at the edited node, never at the root key.
- **Model-agnostic:** never hardcode a model identity or design around one model's quirks.

## Harness limits worth knowing

`load_test.mjs` drives the module against a mocked SillyTavern, but **the proposal-card DOM is never built** — `#cc_edits` does not exist, so any assertion reading card text passes vacuously and proves nothing. Assert on the **notes** the extension emits instead (`auto-skipped`, `Anchor check:`, `proposed edits below`), which are real observable behaviour. The same applies to `cc_applyall` / `cc_dismissall`: `dismissPending()` is a no-op in this harness.

Two more traps that cost time in this repo: an identical re-proposal of a *dismissed* card is correctly suppressed, so a fixture that re-sends the same edit proves nothing; and the log text concatenates `textContent` **and** `innerHTML`, so quotes appear HTML-escaped — match prose, not punctuation.

## Environment

Android/Termux, mobile browser. Inline styles, `position:fixed` sizing, native `prompt()`/`confirm()`. No build step, no imports — one IIFE talking to `SillyTavern.getContext()`.
