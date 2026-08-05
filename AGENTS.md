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
- **Chat-scoped state, not global.** Director, hidden ledger, session history, and the deep-audit resume cursor all live in `chatMetadata.continuityCopilot`.
- **Undo is refusal-first and node-scoped**: backups and drift fingerprints are taken at the edited node, never at the root key.
- **Model-agnostic:** never hardcode a model identity or design around one model's quirks.

## Environment

Android/Termux, mobile browser. Inline styles, `position:fixed` sizing, native `prompt()`/`confirm()`. No build step, no imports — one IIFE talking to `SillyTavern.getContext()`.
