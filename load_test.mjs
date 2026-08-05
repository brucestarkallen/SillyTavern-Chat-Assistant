#!/usr/bin/env node
/**
 * Chat Assistant — MODULE INTEGRITY GATE.  Run:  node load_test.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * SillyTavern loads index.js as an ES MODULE. `node --check index.js` parses a
 * .js file as CommonJS, which silently ACCEPTS things ESM rejects (a duplicate
 * top-level `let`, most importantly). That exact false pass shipped a
 * Summaryception release that failed to load for three versions while every
 * check reported green. This repo was gated on syntax alone until v2.51.0 —
 * the weakest possible gate. This file really EXECUTES the module against a
 * mocked SillyTavern, drives init, and asserts the extension wired itself up.
 *
 * It also carries the source-witness assertions for shipped invariants: the
 * cross-chat contamination guards must stay where they are.
 *
 * Exit code 0 = safe to ship. Non-zero = DO NOT PUSH.
 */
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'index.js'), 'utf8');
let pass = 0, fail = 0;
const ok = (cond, label) => {
    if (cond) { pass++; console.log('  ✓ ' + label); }
    else { fail++; console.log('  ✗ ' + label); }
};

// ── Forgiving DOM mock ───────────────────────────────────────────────
// Every element supports the operations the panel builder uses; children are
// tracked so querySelector/getElementById can find what init created.
const byId = new Map();
function makeEl(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        children: [], style: {}, dataset: {},
        _class: new Set(),
        classList: {
            add: (...c) => c.forEach(x => el._class.add(x)),
            remove: (...c) => c.forEach(x => el._class.delete(x)),
            toggle: (c, f) => { (f === undefined ? !el._class.has(c) : f) ? el._class.add(c) : el._class.delete(c); },
            contains: (c) => el._class.has(c),
        },
        attributes: {},
        setAttribute: (k, v) => { el.attributes[k] = String(v); if (k === 'id') byId.set(String(v), el); },
        getAttribute: (k) => (k in el.attributes ? el.attributes[k] : null),
        removeAttribute: (k) => { delete el.attributes[k]; },
        appendChild: (c) => { el.children.push(c); if (c && c._id) byId.set(c._id, c); return c; },
        append: (...cs) => cs.forEach(c => { if (c && typeof c === 'object') el.children.push(c); }),
        prepend: (...cs) => cs.forEach(c => { if (c && typeof c === 'object') el.children.unshift(c); }),
        removeChild: (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
        remove: () => {},
        insertBefore: (c) => { el.children.unshift(c); return c; },
        _on: new Map(),
        addEventListener: (t, fn) => { if (!el._on.has(t)) el._on.set(t, []); el._on.get(t).push(fn); },
        removeEventListener: (t, fn) => { const a = el._on.get(t) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
        dispatch: (t, ev) => { for (const fn of (el._on.get(t) || []).slice()) fn(ev || { target: el, preventDefault() {}, stopPropagation() {} }); },
        querySelector: () => null, querySelectorAll: () => [],
        closest: () => null, focus: () => {}, blur: () => {},
        click: () => el.dispatch('click'),
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100, right: 100, bottom: 100 }),
        scrollIntoView: () => {},
        options: [], value: '', checked: false, disabled: false, selected: false,
        offsetWidth: 100, offsetHeight: 100, scrollTop: 0, scrollHeight: 0, clientHeight: 100,
        textContent: '', innerText: '',
    };
    // The panel is innerHTML-built and then addressed by id. Registering every
    // id declared in assigned markup makes those lookups work without a real
    // HTML parser; ids never declared still return null, so genuinely missing
    // elements still fail the way they should.
    let _html = '';
    Object.defineProperty(el, 'innerHTML', {
        get() { return _html; },
        set(v) {
            _html = String(v);
            for (const m of _html.matchAll(/id="([^"]+)"/g)) {
                if (!byId.has(m[1])) byId.set(m[1], makeEl('div'));
            }
        },
    });
    Object.defineProperty(el, 'id', {
        get() { return el._id || ''; },
        set(v) { el._id = String(v); byId.set(el._id, el); },
    });
    return el;
}
const documentMock = {
    createElement: (t) => makeEl(t),
    createDocumentFragment: () => makeEl('fragment'),
    getElementById: (id) => byId.get(String(id)) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
};
globalThis.document = documentMock;
globalThis.window = globalThis;
try { globalThis.navigator = { userAgent: 'gate' }; } catch (e) { /* node >= 21 exposes a read-only navigator — good enough */ }
// Toasts are user-visible feedback; capture them so 'loud, never silent'
// behavior is provable instead of vanishing into a no-op.
const toasts = [];
// Dialogs: confirm/prompt were previously undefined — End season was
// undriveable in the harness. Auto-accept and record.
const confirms = [];
globalThis.confirm = (m) => { confirms.push(String(m)); return true; };
globalThis.prompt = globalThis.prompt || (() => '');
const _t = (m) => { toasts.push(String(m)); };
globalThis.toastr = { info: _t, success: _t, warning: _t, error: _t, clear: () => {} };
globalThis.localStorage = {
    _d: new Map(),
    get length() { return this._d.size; },
    key(i) { return [...this._d.keys()][i] ?? null; },
    getItem(k) { return this._d.has(k) ? this._d.get(k) : null; },
    setItem(k, v) { this._d.set(k, String(v)); },
    removeItem(k) { this._d.delete(k); },
};
const chain = new Proxy(function () {}, { get: (_t, p) => (p === 'length' ? 0 : chain), apply: () => chain });
globalThis.$ = new Proxy(function () { return chain; }, { get: () => chain, apply: () => chain });
globalThis.jQuery = globalThis.$;

const event_types = {
    MESSAGE_RECEIVED: 'MESSAGE_RECEIVED', CHAT_CHANGED: 'CHAT_CHANGED',
    GENERATION_STARTED: 'GENERATION_STARTED', MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_EDITED: 'MESSAGE_EDITED', MESSAGE_DELETED: 'MESSAGE_DELETED', APP_READY: 'APP_READY',
};
const handlers = new Map();
const ctx = {
    chat: [], chatMetadata: {}, extensionSettings: {}, characters: [], characterId: 0,
    name1: 'Player', name2: 'Narrator', chatId: 'gate.jsonl',
    eventSource: {
        on: (e, f) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(f); },
        emit: () => {}, removeListener: () => {},
    },
    event_types,
    saveSettingsDebounced: () => {}, saveMetadata: () => {}, saveMetadataDebounced: () => {},
    // Injections are the extension's primary output channel — capture them so
    // pause/unpause behavior is provable instead of vanishing into a no-op.
    extPrompts: new Map(),
    setExtensionPrompt(key, value) { ctx.extPrompts.set(String(key), String(value ?? '')); },
    getCurrentChatId: () => 'gate.jsonl',
    registerSlashCommand: () => {},
    SlashCommandParser: { addCommandObject: () => {} },
    SlashCommand: { fromProps: () => ({}) },
    SlashCommandArgument: { fromProps: () => ({}) },
    SlashCommandNamedArgument: { fromProps: () => ({}) },
    ARGUMENT_TYPE: { STRING: 'string' },
    executeSlashCommandsWithOptions: async () => ({}),
    generateQuietPrompt: async () => '',
    substituteParams: (s) => s,
    saveChat: async () => {},
    extensionPrompts: {},
};
globalThis.SillyTavern = { getContext: () => ctx };
globalThis.structuredClone = globalThis.structuredClone ?? ((o) => JSON.parse(JSON.stringify(o)));

const realError = console.error;
const realLog = console.log;
const errors = [];
const logs = [];
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
const logCap = (...a) => { logs.push(a.map(String).join(' ')); };

process.on('unhandledRejection', (e) => {
    console.error = realError;
    realLog('  ✗ unhandled rejection during load: ' + (e && e.message));
    process.exit(1);
});

const dir = mkdtempSync(join(tmpdir(), 'ca-load-'));
copyFileSync(join(HERE, 'index.js'), join(dir, 'index.js'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');

console.log('== module integrity ==');
let loaded = false, loadErr = '';
console.log = logCap;
try {
    await import(pathToFileURL(join(dir, 'index.js')).href);
    loaded = true;
} catch (e) {
    loadErr = (e && e.message) || String(e);
}
console.log = realLog;
ok(loaded, 'index.js loads as an ES module and executes' + (loaded ? '' : ' — ' + loadErr));

// Drive init through the same path SillyTavern uses.
const ready = handlers.get('APP_READY') || [];
ok(ready.length >= 1, 'APP_READY handler registered at module scope');
console.log = logCap;
try { for (const f of ready) f(); } catch (e) { errors.push('init threw: ' + (e && e.message)); }
console.log = realLog;

const initErrors = errors.filter(x => x.includes('init failed'));
ok(initErrors.length === 0, 'init completed without "init failed"' + (initErrors.length ? ' — ' + initErrors[0] : ''));
ok(logs.some(x => x.includes('ready')), 'init logged ready (panel built, events bound, slash registered)');

console.log('== event wiring ==');
for (const e of ['CHAT_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SWIPED']) {
    ok((handlers.get(e) || []).length >= 1, e + ' handler bound');
}

// The handlers must survive being INVOKED against a bare context.
let threw = '';
try { for (const f of handlers.get('CHAT_CHANGED') || []) f(); } catch (e) { threw = e && e.message; }
ok(!threw, 'CHAT_CHANGED handler runs against an empty chat' + (threw ? ' — threw: ' + threw : ''));
threw = '';
try { for (const f of handlers.get('MESSAGE_SWIPED') || []) f(0); } catch (e) { threw = e && e.message; }
ok(!threw, 'MESSAGE_SWIPED handler runs against an empty chat' + (threw ? ' — threw: ' + threw : ''));

console.log('== shipped invariants (source witnesses) ==');
// v2.51.0 — cross-chat contamination fixes. These strings are load-bearing:
// if a refactor removes them, prove the replacement and update the witness.
ok(SRC.includes('const chatAt = chatRef();\n        const chatApplied = [];'), 'applyEdits captures chat identity at entry');
ok(SRC.includes("edit.status = 'chat changed mid-run \\u2014 not applied';"), 'applyEdits: a mid-run chat switch voids remaining cards instead of fuzzy-matching them into the new chat');
ok(SRC.includes('// ALL state writes happen synchronously with the event'), 'episode conclusion: director state is written before any await');
ok(SRC.includes("if (!justConcluded) return;   // a stale marker on an already-concluded episode stays silent, as before"), 'episode conclusion: stale markers stay silent; only a genuine conclusion announces');
ok(SRC.includes('const led = rootAt.ccHidden;'), 'undo: hidden-ledger writes go through the CAPTURED chat root, never a post-await metaRoot()');
ok(SRC.includes("toast('Chat changed mid-undo"), 'undo: a mid-undo chat switch is surfaced, not silently half-saved');
const guardCount = (SRC.match(/if \(!sameChat\(chatAt\)\)/g) || []).length;
ok(guardCount >= 12, 'sameChat guards present across LLM/apply/undo flows (found ' + guardCount + ', need >= 12)');

console.log('== v2.52.0 invariants (craft doctrine + episode-end editor chain) ==');
// The doctrine lines are load-bearing prompt content: if a refactor drops one,
// the feature silently degrades to the pre-2.52 generic behavior.
ok(SRC.includes('CRAFT \\u2014 the difference between competent and masterpiece'), 'director default carries the CRAFT doctrine (cause / value turns / irony / payoff debt / competent opposition / concrete scale)');
ok(SRC.includes('STACK MEANING before the centerpiece'), 'seed mode expands premises showrunner-style (meaning stack / phases / population / reprice)');
ok(SRC.includes('NORTH STAR:'), 'critique output contract opens with the single highest-leverage NORTH STAR lever');
ok(SRC.includes('FRICTIONLESS SUCCESS'), 'critique holds the story to the masterpiece bar, not only the defect floor');
ok(SRC.includes('LEGACY_DIRECTOR_PROMPT_V257, LEGACY_DIRECTOR_PROMPT_V262, LEGACY_DIRECTOR_PROMPT_V263, LEGACY_DIRECTOR_PROMPT_V264, LEGACY_DIRECTOR_PROMPT_V265, LEGACY_DIRECTOR_PROMPT_V266];'), 'stored 2.49-2.66 defaults auto-upgrade to the current default');
ok(SRC.includes('DELIBERATION \\u2014 if you reason privately'), 'director default carries deliberation discipline for reasoning models');
ok((SRC.match(/Deliberate efficiently \\u2014 the token budget is shared/g) || []).length === 2, 'showrunner and critique prompts carry deliberation discipline');
ok(SRC.includes('raw = await callLLM(msgs2, onPartial, bigPot);'), 'think-consumed recovery runs in an ENLARGED pot — same-size recovery over longer input is mathematically doomed');
ok(SRC.includes('keep it to a single sentence'), 'recovery gives forced reasoning phases an explicit escape hatch');
ok(SRC.includes('FIRST-DRAFT MODE \\u2014 a showrunner second-draft pass will interrogate'), 'with two-pass on, the draft declares fast-draft mode — deep thought moves to the review');
ok(SRC.includes('directorInjectPaused: false') && SRC.includes('critiqueInjectPaused: false'), 'both pause toggles exist and default OFF');
ok(SRC.includes('!settings.directorInjectPaused && d && d.text') && SRC.includes('!settings.critiqueInjectPaused && text'), 'both injectors gate on their pause flag and actively clear when paused');
ok(SRC.includes('never burn directive calls the storyteller cannot see'), 'auto-director skips while its channel is paused');
ok(SRC.includes("don't count toward a trigger the storyteller cannot receive"), 'auto-critique neither counts nor fires while paused');
ok(SRC.includes('&& !settings.critiqueInjectPaused) {'), 'the episode-end editor pass respects the pause');
ok(SRC.includes('if (clearedText.trim()) {'), 'a whitespace-only directive is treated as empty by the end-season audit');
ok(SRC.includes('CAST \\u2014 before writing beats, sweep the established cast'), 'director default carries the CAST law (stake sweep, jurisdiction-by-definition, no furniture placement)');
ok(SRC.includes('FURNITURE CHARACTERS'), 'critique bar catches furniture characters and absent stakeholders');
ok(SRC.includes('SHOWRUNNER running the second-draft pass'), 'directives get a showrunner second-draft pass (premise ambition, the memorable moment, wasted cast, safety, logic)');
ok(SRC.includes('directorTwoPass: true'), 'the second-draft pass defaults ON');
ok(SRC.includes("const isRestart = mode === 'new' && !!String(prev?.text || '').trim();"), 'New over a live directive is treated as a restart');
ok(SRC.includes('The player RESTARTED this episode'), 'restart carries its own prompt contract (never aired / genuinely different)');
ok(SRC.includes('function raceTransport('), 'every transport await runs under the stall watchdog');
ok((SRC.match(/raceTransport\(/g) || []).length >= 5, 'watchdog covers stream start, stream chunks, plain request, and the fallback backend (found ' + (SRC.match(/raceTransport\(/g) || []).length + ' uses, need >= 5)');
ok(SRC.includes('llmTimeoutSec: 300'), 'stall timeout defaults to 300s and is configurable (0 = off)');
ok(SRC.includes('function busyTicker('), 'busy bubbles carry a liveness ticker');
ok((SRC.match(/busyTicker\(busyNote/g) || []).length === 5, 'all five LLM flows (directive, critique, status, seeds, edit) tick (found ' + (SRC.match(/busyTicker\(busyNote/g) || []).length + ', need 5)');
ok((SRC.match(/\], tick(C|X)?\.onPartial\);/g) || []).length >= 6, 'every ticked flow forwards live stream progress into the readout');
ok(SRC.includes('PLAYED-STATE: NEVER PLAYED'), 'end-season audit declares an unplayed directive as such (anti-spiral)');
ok(SRC.includes('a clean audit is a successful audit'), 'the audit has an explicit clean exit so it never manufactures findings');
ok((SRC.match(/msgAt:/g) || []).length === 2, 'both directive stores record where playtime starts (found ' + (SRC.match(/msgAt:/g) || []).length + ', need 2)');
ok(!/if \(running\) return;\s*\n\s*running = true/.test(SRC), 'no user-initiated entry can die silently at the running flag any more');
ok(SRC.includes('critiqueOnEpisode: true'), 'episode-end auto-critique defaults ON');
const fnAt = SRC.indexOf('async function onEpisodeConcluded(chatAt)');
ok(fnAt > -1, 'episode conclusion routes through onEpisodeConcluded');
const critAt = SRC.indexOf("await generateCritique(true, 'episode');", fnAt);
const dirAt = SRC.indexOf('maybeAutoDirector();', fnAt);
ok(critAt > -1 && dirAt > -1 && critAt < dirAt, 'inside the chain, the editor pass is AWAITED before the next episode is directed (review -> plan order)');
ok((SRC.match(/onEpisodeConcluded\(chatAt\)\.catch\(/g) || []).length === 2, 'both conclusion paths (episode marker + status check) run the chain (fire-and-forget, rejection captured)');
ok(SRC.includes('if (concluded) onEpisodeConcluded(chatAt).catch('), 'status-check path fires the chain AFTER its finally releases the running lock (fired inside it, both steps self-skip)');
ok(!SRC.includes('maybeAutoDirector(); // auto mode: chain the next episode immediately'), 'no conclusion path bypasses the editor by auto-directing directly');
// Live-settings proof: init actually installed the new default and flag.
const CA = ctx.extensionSettings['continuityCopilot'] || {};
ok(CA.critiqueOnEpisode === true, 'live settings after init: critiqueOnEpisode is true');
ok(typeof CA.directorPrompt === 'string' && CA.directorPrompt.includes('CRAFT \u2014 the difference between competent and masterpiece'), 'live settings after init: director prompt is the CRAFT default');
ok(typeof CA.directorPrompt === 'string' && CA.directorPrompt.includes('CAST \u2014 before writing beats'), 'live settings after init: director prompt carries the CAST law');
ok(CA.directorTwoPass === true, 'live settings after init: directorTwoPass is true');
// The MESSAGE_RECEIVED handler (which hosts the conclusion chain) must survive a bare invoke.
threw = '';
try { for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(0); } catch (e) { threw = e && e.message; }
ok(!threw, 'MESSAGE_RECEIVED handler runs against an empty chat' + (threw ? ' \u2014 threw: ' + threw : ''));

console.log('== v2.52.0 behavior: conclusion runs review -> plan through the real code paths ==');
// Arrange: live profile, auto director, an unconcluded episode, then a
// storyteller reply carrying [EPISODE_END]. The mock transport records WHICH
// prompt arrived WHEN — proving execution order, not just source order.
const llmCalls = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        if (sys.includes('NORTH STAR')) { llmCalls.push('critique'); return 'NORTH STAR: play the irony gap harder.\n1. Track every named character present until they visibly exit.'; }
        if (sys.includes('SHOWRUNNER running the second-draft pass')) { llmCalls.push('review'); return 'Intensity: standard\nSHOWRUNNER CUT: the rematch everyone bet against — now with the registrar in the ring.'; }
        if (sys.includes('expert story director')) { llmCalls.push('directive'); return 'Intensity: standard\n1. EPISODE PREMISE — the rematch everyone bet against.'; }
        llmCalls.push('other'); return 'ONGOING \u2014 fine';
    },
};
CA.profileId = 'gate-profile';
CA.directorMode = 'auto';
CA.streaming = false;
CA.critiqueOnEpisode = true;
CA.critiqueAuto = 0;
CA.directorWatcherPass = false; // legacy flow sections prove the two-pass contract; the three-pass path has its own section below
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'SECRET: episode one beats', episode: 1, concluded: false, ts: 1 }, directorEp: 1 };
ctx.chat.push({ is_user: false, mes: 'The duel ends and the crowd goes silent. [EPISODE_END]' });
console.log = logCap;
try { for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1); } catch (e) { errors.push('sim handler threw: ' + (e && e.message)); }
await new Promise(r => setTimeout(r, 200)); // the chain is fire-and-forget from the handler; let it drain
console.log = realLog;
ok(!errors.some(x => x.includes('sim handler threw')), 'conclusion handler ran the sim without throwing');
ok(llmCalls[0] === 'critique', 'the EDITOR pass fired first (got order: ' + llmCalls.join(', ') + ')');
ok(llmCalls[1] === 'directive', 'the NEXT directive fired second — designed with the fresh notes already saved');
ok(llmCalls[2] === 'review', 'the showrunner pass fired third — draft in, cut out');
ok(String(ctx.chatMetadata.cc_critique || '').startsWith('NORTH STAR:'), 'the review landed in cc_critique under the NORTH STAR contract');
const dNow = (ctx.chatMetadata['continuityCopilot'] || {}).director || {};
ok(dNow.episode === 2 && !dNow.concluded, 'auto mode chained to a live episode 2 after the review (got E' + dNow.episode + (dNow.concluded ? ' concluded' : '') + ')');
ok(String(dNow.text || '').includes('SHOWRUNNER CUT'), 'the STORED directive is the showrunner cut, not the first draft');

console.log('== v2.55.0 behavior: restart keeps the episode, discards the old take ==');
// Arrange: a live, unconcluded E2 directive, then press New (= Restart).
// The mock records the SYSTEM and USER prompts of both passes so we can prove
// what the model was actually told, not merely what the source says.
llmCalls.length = 0;
let capturedDraft = null, capturedReview = null;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        const usr = (messages && messages[1] && messages[1].content) || '';
        if (sys.includes('SHOWRUNNER running the second-draft pass')) {
            llmCalls.push('review'); capturedReview = { sys, usr };
            return 'Intensity: intense\nRESTARTED CUT: the tribunal nobody called for.';
        }
        llmCalls.push('directive'); capturedDraft = { sys, usr };
        return 'Intensity: intense\n1. EPISODE PREMISE — a tribunal, not a duel.';
    },
};
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'OLD E2: the duel on the welcome-day grounds.', episode: 2, concluded: false, ts: 5 }, directorEp: 2 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f(); // refresh the label from the live directive
ok(document.getElementById('cc_dirnew').textContent.includes('Restart'), 'with a live directive the button reads Restart');
console.log = logCap;
try { document.getElementById('cc_dirnew').click(); await new Promise(r => setTimeout(r, 250)); } catch (e) { errors.push('restart click threw: ' + (e && e.message)); }
console.log = realLog;
ok(!errors.some(x => x.includes('restart click threw')), 'the New/Restart button ran without throwing');
ok(capturedDraft && capturedDraft.sys.includes('The player RESTARTED this episode'), 'restart draft used the restart prompt contract, not the plain new-episode prompt');
ok(capturedDraft && capturedDraft.usr.includes('[DISCARDED DIRECTIVE') && capturedDraft.usr.includes('OLD E2: the duel'), 'the rejected directive WAS shown to the model (without it, a restart can return the same episode)');
ok(capturedDraft && !capturedDraft.usr.includes('[PREVIOUS EPISODE DIRECTIVE'), 'the discarded episode is NOT passed as concluded history — it never aired');
ok(capturedReview && capturedReview.sys.includes('This episode is a RESTART'), 'the showrunner pass inherits the restart contract and cannot drift back to the rejected episode');
const dR = (ctx.chatMetadata['continuityCopilot'] || {}).director || {};
ok(dR.episode === 2, 'restart KEPT the episode number (got E' + dR.episode + ', want E2)');
ok(!dR.concluded, 'restart leaves the episode live, not concluded');
ok(String(dR.text || '').includes('RESTARTED CUT'), 'the restarted directive replaced the old text');
// Label honesty: the same button must read Restart while a directive is live.
ctx.chatMetadata['continuityCopilot'] = {};
for (const f of handlers.get('CHAT_CHANGED') || []) await f(); // the real refresh path
ok(document.getElementById('cc_dirnew').textContent.includes('New'), 'with no directive the same button reads New');

console.log('== v2.56.0 behavior: a hung provider cannot wedge the extension ==');
// The reported symptom: one request never settles -> `running` held forever ->
// every later click on every model dies silently. Prove the watchdog releases
// it AND that the very next click works.
llmCalls.length = 0;
CA.llmTimeoutSec = 1;           // 1s deadline for the test
CA.streaming = false;
let hangs = 0;
ctx.ConnectionManagerRequestService = {
    sendRequest: (pid, messages) => { hangs++; return new Promise(() => {}); },   // never settles
};
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E2 live directive.', episode: 2, concluded: false, ts: 9 }, directorEp: 2 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
console.log = logCap;
document.getElementById('cc_dirnew').click();               // restart against the hung provider
await new Promise(r => setTimeout(r, 300));
const busyDuringHang = true;                                 // op in flight; second click must be LOUD, not silent
const toastsBefore = toasts.length;
document.getElementById('cc_dirnew').click();
const gotBusyToast = toasts.length > toastsBefore && /Another operation is still running/.test(String(toasts[toasts.length - 1]));
await new Promise(r => setTimeout(r, 1400));                 // let the 1s watchdog fire
console.log = realLog;
ok(gotBusyToast, 'clicking during an in-flight operation is LOUD (busy toast), never a silent return');
ok(hangs === 1, 'the hung request was made exactly once (got ' + hangs + ')');
ok((ctx.chatMetadata['continuityCopilot'].director || {}).text === 'E2 live directive.', 'the directive was left unchanged by the timed-out attempt');
// Self-heal: the very next click, now against a working transport, must succeed.
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        if (sys.includes('SHOWRUNNER running the second-draft pass')) return 'Intensity: standard\nHEALED CUT: the extension recovered.';
        return 'Intensity: standard\n1. EPISODE PREMISE — recovery.';
    },
};
console.log = logCap;
document.getElementById('cc_dirnew').click();
await new Promise(r => setTimeout(r, 300));
console.log = realLog;
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('HEALED CUT'), 'after the watchdog fired, the NEXT click succeeded — running was released, no reload needed');

console.log('== v2.57.0 behavior: the busy bubble proves the extension is alive ==');
// Streaming transport that yields chunks with real gaps; the bubble must show
// climbing character counts, the phase change to the showrunner pass, and the
// auto-abort countdown — counts only, never directive content.
llmCalls.length = 0;
CA.llmTimeoutSec = 60;
CA.streaming = true;
const bubbleSnapshots = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages, maxTok, opts) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        const isReview = sys.includes('SHOWRUNNER running the second-draft pass');
        if (!isReview) globalThis.__draftSys = sys;
        return function stream() {
            return (async function* () {
                const words = isReview ? ['Intensity: standard\n', 'TICKED CUT: ', 'alive and streaming.'] : ['Intensity: standard\n', '1. EPISODE ', 'PREMISE — liveness.'];
                for (const w of words) { await sleep(40); yield { text: w }; }
            })();
        };
    },
};
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E2 to restart with ticks.', episode: 2, concluded: false, ts: 11 }, directorEp: 2 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const logEl = document.getElementById('cc_log');
const snap = () => {
    const kids = (logEl && logEl.children) || [];
    for (const k of kids) if (k && k.className && String(k.className).includes('cc_busy') && k.textContent) bubbleSnapshots.push(k.textContent);
};
const snapIv = setInterval(snap, 25);
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(700);
console.log = realLog;
clearInterval(snapIv);
snap();
const sawWaiting = bubbleSnapshots.some(t => /waiting for the first token/.test(t));
const sawChars = bubbleSnapshots.some(t => /\b\d+ chars/.test(t));
const sawPhase2 = bubbleSnapshots.some(t => /showrunner second draft/.test(t));
const sawCountdown = bubbleSnapshots.some(t => /auto-abort in \d+s/.test(t));
const leakedContent = bubbleSnapshots.some(t => /PREMISE|TICKED CUT/.test(t));
ok(sawWaiting || sawChars, 'the ticker rendered (waiting state or live counts) — got ' + bubbleSnapshots.length + ' snapshots');
ok(sawChars, 'character counts climbed on stream chunks — liveness is visible');
ok(sawPhase2, 'the phase label flipped to the showrunner second draft mid-flow');
ok(sawCountdown, 'the watchdog countdown is visible, so a silent provider has a visible fuse');
ok(!leakedContent, 'secrecy held: the readout showed counts, never directive content');
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('TICKED CUT'), 'the streamed restart completed and stored the showrunner cut');
ok(/FIRST-DRAFT MODE/.test(String(globalThis.__draftSys || '')), 'two-pass draft ran in declared fast-draft mode');

console.log('== v2.58.0 behavior: end-season audit knows how much actually aired ==');
// Case 1: the directive stored by the previous sim was never played (no
// storyteller replies were appended after it was set). Ending the season must
// tell the audit NEVER PLAYED and forbid chat-searching.
let auditPrompt = null;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const usr = (messages && messages[messages.length - 1] && messages[messages.length - 1].content) || '';
        if (/PLAYED-STATE:/.test(usr)) auditPrompt = usr;
        return 'Nothing references the dead plan.';
    },
};
console.log = logCap;
document.getElementById('cc_diroff').click();
await sleep(400);
console.log = realLog;
ok(confirms.length > 0, 'End season asked for confirmation through the real dialog');
ok(auditPrompt !== null, 'the residue audit fired through the normal pipeline');
ok(/PLAYED-STATE: NEVER PLAYED/.test(String(auditPrompt)), 'an unplayed directive is declared NEVER PLAYED to the audit');
ok(/do not search the chat for them/.test(String(auditPrompt)), 'the audit is told chat absence is expected — no spiraling on missing beats');
ok(/episode 2/.test(String(auditPrompt)), 'the audit names the exact cleared episode, not "the season"');
ok(/earlier episodes of this season genuinely aired/i.test(String(auditPrompt)), 'season history is fenced off from the audit scope');
ok((ctx.chatMetadata['continuityCopilot'] || {}).director === null, 'the directive was cleared');
// Case 2: a partially played directive — two storyteller replies after set.
auditPrompt = null;
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E1 partial plan.', episode: 1, concluded: false, ts: 12, msgAt: ctx.chat.length }, directorEp: 1 };
ctx.chat.push({ is_user: false, mes: 'Reply one under the plan.' });
ctx.chat.push({ is_user: false, mes: 'Reply two under the plan.' });
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
console.log = logCap;
document.getElementById('cc_diroff').click();
await sleep(400);
console.log = realLog;
ok(/PLAYED-STATE: PARTIALLY PLAYED \u2014 about 2 storyteller replies/.test(String(auditPrompt)), 'a half-played directive reports its real reply count to the audit');
ok(/narrated on screen is history and stays/.test(String(auditPrompt)), 'partial audits protect what actually aired');

console.log('== v2.59.0 behavior: think-consumed recovery gets a bigger pot and succeeds ==');
// A reasoning model burns the whole pot on <think>. The recovery call must
// arrive with an ENLARGED maxTok and the transcription demand, then succeed.
CA.maxTokens = 4096;            // -> bigPot = min(32768, max(8192, 6144)) = 8192
CA.directorTwoPass = false;     // isolate Phase A
CA.thinkRetries = 2;
ctx.chatMetadata['continuityCopilot'] = {};
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const potCalls = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages, maxTok) => {
        const last = (messages[messages.length - 1] && messages[messages.length - 1].content) || '';
        potCalls.push({ maxTok, recovery: /Transcribe the decisions above/.test(last), fastDraft: /FIRST-DRAFT MODE/.test((messages[0] && messages[0].content) || '') });
        if (potCalls.length === 1) return '<think>endless deliberation about the perfect premise, forty thousand tokens of it</think>';
        return 'Intensity: standard\n1. EPISODE PREMISE — transcribed from the finished reasoning.';
    },
};
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
ok(potCalls.length === 2, 'exactly one recovery round was needed (got ' + potCalls.length + ' calls)');
ok(potCalls[0] && potCalls[0].maxTok === 4096 && !potCalls[0].recovery, 'first attempt ran at the configured budget');
ok(potCalls[0] && !potCalls[0].fastDraft, 'single-pass mode keeps full deliberation — fast-draft only when a review will follow');
ok(potCalls[1] && potCalls[1].maxTok === 8192, 'the recovery ran in the enlarged pot (got ' + (potCalls[1] && potCalls[1].maxTok) + ', want 8192)');
ok(potCalls[1] && potCalls[1].recovery, 'the recovery demanded transcription of the finished reasoning');
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('transcribed from the finished reasoning'), 'the directive was recovered and stored — the thinking was not wasted');

console.log('== v2.61.0 behavior: pause clears the live injection, storage stays ==');
// State from the previous sim: a live directive. Seed editor notes too, then
// pause both, re-apply via the real refresh path, and prove: slots cleared,
// storage intact, Peek-able; unpause restores both slots verbatim.
ctx.chatMetadata.cc_critique = 'NORTH STAR: keep the irony taut.\n1. Track every named presence.';
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const dirSlot = () => String(ctx.extPrompts.get('cc_director') || '');
const critSlot = () => String(ctx.extPrompts.get('cc_critique_inject') || '');
ok(dirSlot().includes('transcribed from the finished reasoning'), 'unpaused: the directive is live in its injection slot');
ok(critSlot().includes('NORTH STAR: keep the irony taut.'), 'unpaused: the editor notes are live in their injection slot');
CA.directorInjectPaused = true;
CA.critiqueInjectPaused = true;
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot() === '', 'paused: the director slot is actively cleared, not merely skipped');
ok(critSlot() === '', 'paused: the editor-notes slot is actively cleared');
ok(String((ctx.chatMetadata['continuityCopilot'].director || {}).text || '').includes('transcribed from the finished reasoning'), 'paused: the directive itself is still stored untouched');
ok(String(ctx.chatMetadata.cc_critique || '').includes('NORTH STAR'), 'paused: the editor notes are still stored untouched');
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot().includes('transcribed from the finished reasoning') && critSlot().includes('NORTH STAR'), 'unpause restores both live slots verbatim from storage');

console.log('== v2.62.0 behavior: paused channels burn zero background calls ==');
let bgCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { bgCalls++; return 'Intensity: standard\n1. EPISODE PREMISE — should not exist while paused.'; } };
CA.directorMode = 'auto';
CA.directorInjectPaused = true;
CA.critiqueAuto = 1;
CA.critiqueInjectPaused = true;
CA.directorTwoPass = false;
ctx.chatMetadata['continuityCopilot'] = {};
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ctx.chat.push({ is_user: false, mes: 'A reply lands while both channels are paused.' });
console.log = logCap;
for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1);
await sleep(250);
console.log = realLog;
ok(bgCalls === 0, 'paused: neither auto-director nor auto-critique burned a call (got ' + bgCalls + ')');
ok(!(ctx.chatMetadata['continuityCopilot'] || {}).director, 'paused: no invisible directive was generated');
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
ctx.chat.push({ is_user: false, mes: 'A reply lands after unpausing.' });
console.log = logCap;
for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1);
await sleep(250);
console.log = realLog;
ok(bgCalls > 0, 'unpaused: automation resumed on the very next reply (got ' + bgCalls + ' calls)');


console.log('== v2.63.0 behavior: player sovereignty — the plan cannot pre-decide the player ==');
// The complaint this closes: directives were written as destiny ("MC does not
// help") instead of premise ("bullying erupts in front of the MC — the answer
// is theirs"). The fix is structural: the FORMAT can no longer express a
// predetermined outcome. These assertions hold that shape in place.
CA.directorMode = 'off';
// (a) The shipping default (migrated into live settings at init) carries the new spine.
ok(String(CA.directorPrompt || '').includes('THE PLAN STOPS AT THE PLAYER'), 'default prompt carries the stop-at-the-player beat grammar law');
ok(String(CA.directorPrompt || '').includes('EPISODE QUESTION'), 'default prompt anchors the episode on a player-facing EPISODE QUESTION');
ok(String(CA.directorPrompt || '').includes('is a stolen choice'), 'the grammar law teaches by example: the world half is a beat, the player half is a stolen choice');
ok(!String(CA.directorPrompt || '').includes('natural end state of the episode'), 'the fixed-outcome landing definition is gone from the shipping default');
ok(String(CA.directorPrompt || '').includes('one line per likely answer naming how the world responds'), 'landing maps consequences per answer instead of scripting one outcome');
ok(String(CA.directorPrompt || '').includes('(7) THEME'), 'craft doctrine gained the THEME law (value under test, felt not announced)');
// (b) The showrunner pass hunts sovereignty violations and cannot sharpen into illogic.
ok(SRC.includes('6. SOVEREIGNTY \\u2014 hunt every sentence that decides FOR the player'), 'showrunner pass carries the SOVEREIGNTY interrogation');
ok(SRC.includes('settle your seven interrogations'), 'showrunner deliberation counts all seven interrogations');
ok(SRC.includes('scripts the player\\\'s half of a collision is a downgrade'), 'sharpening has an explicit truth/freedom counterweight');
ok(SRC.includes('plausible causation \\u2014 would a skeptical viewer accept why each beat happens now'), 'LOGIC interrogation now checks causal plausibility, not just rule compliance');
// (c) The live storyteller wrapper: episode ends on the ANSWERED question, never on reaching a scripted landing.
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E9 sovereignty plan.', episode: 9, concluded: false, ts: 1, msgAt: ctx.chat.length }, directorEp: 9 };
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const wrap = dirSlot();
ok(wrap.includes('stop at the player'), 'wrapper orders the storyteller to stop at the player\u2019s decision point');
ok(wrap.includes('unchosen branches never happened'), 'wrapper quarantines unchosen consequence branches from canon');
ok(wrap.includes('answered by the player on screen'), 'wrapper ends the episode on the answered question');
ok(!wrap.includes('When the LANDING state is fully reached'), 'the old reach-the-landing teleology is gone from the wrapper');
// The injection voice is universal: the mock persona is the role-word 'Player',
// so the wrapper falls back to the author's note — never a hardcoded name,
// never the word "user".
ok(wrap.startsWith("Author's note — my director's plan"), 'role-word persona → the author\'s note, not a role label');
ctx.name1 = 'Jovan';
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot().startsWith("Jovan's note — my director's plan"), 'a named persona speaks as themselves');
ctx.name1 = 'User';
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(dirSlot().startsWith("Author's note — my director's plan"), 'ST\'s unset default "User" also falls back — the word user never enters the voice');
ctx.name1 = 'Player';
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
ok(!SRC.includes('Bruce'), 'no player name is hardcoded anywhere in the extension');
ok((SRC.match(/directorDepth: 3,/g) || []).length === 1 && SRC.includes('numSetting(settings?.directorDepth, 3, 0, 20)'), 'director steering defaults to depth 3 — between memory reference (4) and beat-level outcome notes (0): reference → plan → outcome → reply');
// (d) Migration mechanics, executed with the real values: the v2.62 default was
// frozen verbatim, differs from the new default, upgrades when stored, and a
// customized copy is left alone.
const hookM = SRC.match(/const HOOK_LINE = ('(?:[^'\\]|\\.)*');/);
const v262M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V262 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
const defM = SRC.match(/const DEFAULT_DIRECTOR_PROMPT = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!(hookM && v262M && defM), 'HOOK_LINE, frozen V262, and new default are all extractable from source');
let v262 = '', dflt = '';
try {
    const HOOK = new Function('return ' + hookM[1])();
    v262 = new Function('HOOK_LINE', 'return ' + v262M[1])(HOOK);
    dflt = new Function('HOOK_LINE', 'return ' + defM[1])(HOOK);
} catch (e) { ok(false, 'evaluating the prompt constants threw: ' + (e && e.message)); }
ok(v262.includes('natural end state of the episode') && v262.includes('conclude naturally at the landing'), 'the freeze preserved the old v2.62 text verbatim (stored copies will match it)');
ok(v262.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.62 default');
const migrates = (stored) => [v262].some(pp => stored.trim() === pp.trim());
ok(migrates(v262 + '\n'), 'migration predicate: an untouched stored v2.62 default upgrades');
ok(!migrates(v262 + '\nMY CUSTOM LAW'), 'migration predicate: a user-customized prompt is never overwritten');

console.log('== v2.64.0 behavior: total sovereignty — no seam left for the plan to script the player ==');
// v2.63 banned the player as "author of a response" and a live directive
// promptly scripted the player's ENTIRE duel as involuntary events ("his
// Reaving surfaces involuntarily"), scripted his dialogue ("Fine."), and
// presupposed the reveal at premise level ("the question isn't whether his
// tier comes out"). Each seam is now closed, and the version stamp that
// silently stayed at 2.62.0 is now locked to the manifest.
// (a) Version lock: the in-code header stamp can never drift from the manifest again.
const verM = SRC.match(/const VERSION = '([^']+)';/);
let maniVer = '';
try { maniVer = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')).version; } catch (e) {}
ok(!!verM && !!maniVer && verM[1] === maniVer, 'in-code VERSION stamp matches manifest.json (' + (verM && verM[1]) + ' vs ' + maniVer + ')');
// (b) The shipping default carries the total-subject ban.
const dp = String(CA.directorPrompt || '');
ok(dp.includes('never be the SUBJECT of a planned sentence'), 'beats law: the player may never be the subject of any planned sentence');
ok(dp.includes('involuntary is still theirs'), 'the involuntary loophole is named and closed');
ok(dp.includes('"his real tier comes out" is a stolen choice'), 'the reveal-by-plan case is taught by example');
ok(dp.includes("the question isn't whether the player does X"), 'premise-level presupposition is banned with its tell named');
ok(dp.includes("The TURN is the WORLD's move"), 'the TURN must be an NPC/world move, never a player performance');
ok(dp.includes('choreograph ONLY the NPC'), 'scheduled events choreograph only the NPC half — every player answer stays blank');
ok(!dp.includes('never as the author of a response'), 'the old response-only phrasing (the seam) is gone from the shipping default');
// (c) Showrunner pass hunts the whole class.
ok(SRC.includes('theft with an alibi'), 'SOVEREIGNTY names involuntary scripting as theft with an alibi');
ok(SRC.includes('even one scripted word'), 'SOVEREIGNTY catches scripted player dialogue');
ok(SRC.includes('STAGED by the world and completed by the player'), 'THE MOMENT must be world-staged, never a scripted player action');
// (d) Live wrapper: the storyteller is told slips belong to the player too.
for (const f of handlers.get('CHAT_CHANGED') || []) await f();
const wrap64 = dirSlot();
ok(wrap64.includes('so are their slips'), 'wrapper: player slips are player events');
ok(wrap64.includes('let the player decide what breaks'), 'wrapper: pressure is staged, breakage is played');
// (e) Migration: v2.63 default frozen verbatim, upgrades, customization untouched.
const v263M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V263 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v263M, 'frozen V263 default is extractable from source');
let v263 = '';
try {
    const HOOK2 = new Function('return ' + hookM[1])();
    v263 = new Function('HOOK_LINE', 'return ' + v263M[1])(HOOK2);
} catch (e) { ok(false, 'evaluating V263 threw: ' + (e && e.message)); }
ok(v263.includes('never as the author of a response'), 'the freeze preserved the v2.63 text verbatim (stored copies will match it)');
ok(v263.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.63 default');
const migrates64 = (stored) => [v262, v263].some(pp => stored.trim() === pp.trim());
ok(migrates64(v263 + '\n'), 'migration predicate: an untouched stored v2.63 default upgrades');
ok(!migrates64(v263 + '\nMY CUSTOM LAW'), 'migration predicate: a user-customized prompt is never overwritten');

// (f) v2.65 recognition grammar: V264 frozen verbatim, upgrades, and the new laws exist.
const v264M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V264 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v264M, 'frozen V264 default is extractable from source');
let v264 = '';
try {
    const HOOK4 = new Function('return ' + hookM[1])();
    v264 = new Function('HOOK_LINE', 'return ' + v264M[1])(HOOK4);
} catch (e) { ok(false, 'evaluating V264 threw: ' + (e && e.message)); }
ok(v264.includes('Plan the temptation, never the yielding'), 'the freeze preserved the v2.64 text verbatim (stored copies will match it)');
ok(!v264.includes('RECOGNITION LAW'), 'the V264 freeze is genuinely the pre-recognition text, not a copy of the new default');
ok(createHash('sha256').update(v264).digest('hex') === '0acbd3b073a0f7ed69de16da2465ccab52580d7d5a4eec78845ece753067482c', 'V264 freeze is byte-identical (sha256 pinned) \u2014 a freeze permits no edit, phrase-preserving or not');
ok(v264.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.64 default');
const migrates65 = (stored) => [v262, v263, v264].some(pp => stored.trim() === pp.trim());
ok(migrates65(v264 + '\n'), 'migration predicate: an untouched stored v2.64 default upgrades');
ok(!migrates65(v264 + '\nMY CUSTOM LAW'), 'migration predicate: a customized v2.64 prompt is never overwritten');
ok(dflt.includes('real screen time instead of a summary line'), 'delights palette demands screen time for repricing payoffs');
ok(dflt.includes('AMBIENT INTERLUDE') && dflt.includes('AMBIENT EXCEPTION'), 'ambient interlude shape exists and is exempted from the DILEMMA');
ok(dflt.includes('dismissed\u2192reckoned-with'), 'turn-the-value vocabulary includes recognition flips');
ok(SRC.includes('7. PAYOFF ON SCREEN') && SRC.includes('A payoff summarized into aftermath is a skipped payoff'), 'showrunner interrogates payoff staging as craft');

// (g) v2.66 audience balance: V265 frozen verbatim + hash, rotation, either-direction, warm register.
const v265M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V265 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v265M, 'frozen V265 default is extractable from source');
let v265 = '';
try {
    const HOOK5 = new Function('return ' + hookM[1])();
    v265 = new Function('HOOK_LINE', 'return ' + v265M[1])(HOOK5);
} catch (e) { ok(false, 'evaluating V265 threw: ' + (e && e.message)); }
ok(v265.includes('lands in full before anything answers it'), 'the freeze preserved the v2.65 text verbatim (stored copies will match it)');
ok(!v265.includes('never the same audience two episodes running'), 'the V265 freeze is genuinely the pre-rotation text, not a copy of the new default');
ok(createHash('sha256').update(v265).digest('hex') === '025e5429b3a43fa61acf38a472c4ca9edf75c75f47b7b953f467c8f40bc2e8ef', 'V265 freeze is byte-identical (sha256 pinned) \u2014 a freeze permits no edit, phrase-preserving or not');
ok(v265.includes('RECOGNITION LAW') && v265.includes('the OLD reading scores first'), 'recognition-era freeze carries the law (historical witness)');
ok(v265.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.65 default');
const migrates66 = (stored) => [v262, v263, v264, v265].some(pp => stored.trim() === pp.trim());
ok(migrates66(v265 + '\n'), 'migration predicate: an untouched stored v2.65 default upgrades');
ok(!migrates66(v265 + '\nMY CUSTOM LAW'), 'migration predicate: a customized v2.65 prompt is never overwritten');
ok(!dflt.includes('RECOGNITION LAW') && !dflt.includes('never the same audience two episodes running'), 'v2.67 default carries no recognition legislation \u2014 the insight moved to taste');
ok(dflt.includes('cold (the room that muttered who-is-this-guy') && dflt.includes('or warm (a best friend re-seeing'), 'delights palette names cold and warm registers as equals');
ok(dflt.includes('a masterpiece owes the player nothing but itself'), 'delights are a palette, not a quota \u2014 delight-free episodes are lawful');
ok(dflt.includes('taste knowledge, not a quota'), 'palette is explicitly taste, not law');

// (h) v2.67 three-layer room: V266 frozen + hashed, watcher pass exists, wired, sovereign, minimal-cut.
const v266M = SRC.match(/const LEGACY_DIRECTOR_PROMPT_V266 = (\[[\s\S]*?\n    \]\.join\('\\n'\));/);
ok(!!v266M, 'frozen V266 default is extractable from source');
let v266 = '';
try {
    const HOOK6 = new Function('return ' + hookM[1])();
    v266 = new Function('HOOK_LINE', 'return ' + v266M[1])(HOOK6);
} catch (e) { ok(false, 'evaluating V266 threw: ' + (e && e.message)); }
ok(createHash('sha256').update(v266).digest('hex') === '56360487bed0a38f4bd3f6ad8f0046b71c301e184c695da226c1d16ac984426e', 'V266 freeze is byte-identical (sha256 pinned) \u2014 a freeze permits no edit, phrase-preserving or not');
ok(v266.includes('never the same audience two episodes running'), 'V266 freeze carries the rotation law (historical witness)');
ok(v266.trim() !== dflt.trim(), 'the new default genuinely differs from the frozen v2.66 default');
const migrates67 = (stored) => [v262, v263, v264, v265, v266].some(pp => stored.trim() === pp.trim());
ok(migrates67(v266 + '\n'), 'migration predicate: an untouched stored v2.66 default upgrades');
ok(!migrates67(v266 + '\nMY CUSTOM LAW'), 'migration predicate: a customized v2.66 prompt is never overwritten');
ok(SRC.includes('const WATCHER_PASS_PROMPT'), 'watcher pass prompt exists');
ok(SRC.includes('MINIMAL CUT') && SRC.includes('if the episode already airs, output it unchanged'), 'watcher is a minimal final cut, not a third rewrite');
ok(SRC.includes('wish for situations, never for answers'), 'watcher sovereignty: enjoyment may never script the player');
ok(SRC.includes('slow is welcome when slow is what the story is hungry for'), 'watcher legitimizes slow episodes by taste, not schedule');
ok(SRC.includes("tick.phase('watcher final cut')") && SRC.includes('directorWatcherPass') && SRC.includes('shipping the showrunner cut'), 'watcher pass is wired into the directive flow with empty-fallback');
ok(SRC.includes('directorWatcherPass: true,'), 'watcher pass defaults on');
ok(SRC.includes("el('cc_dir_watcher').checked = settings.directorWatcherPass !== false;") && SRC.includes("settings.directorWatcherPass = el('cc_dir_watcher').checked;"), 'watcher toggle load/save round-trips');
ok(!dflt.includes('every fourth or fifth episode') && dflt.includes('available whenever the story is hungry for breath'), 'ambient interlude is available on demand, not on a schedule');

console.log('== v2.67.0 behavior: the watcher third pass ==');
const wCalls = [];
let watcherReturn = 'Intensity: standard\nWATCHER AIRED ONE: same cut, one delight staged.';
let srReturn = 'Intensity: standard\nSHOWRUNNER CUT ONE: the rematch, sharpened.';
globalThis.__watcherSys = ''; globalThis.__watcherUsr = '';
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        const usr = (messages && messages[messages.length - 1] && messages[messages.length - 1].content) || '';
        if (sys.includes('THE WATCHER')) { wCalls.push('watcher'); globalThis.__watcherSys = sys; globalThis.__watcherUsr = usr; return watcherReturn; }
        if (sys.includes('SHOWRUNNER running the second-draft pass')) { wCalls.push('review'); return srReturn; }
        if (sys.includes('expert story director')) { wCalls.push('directive'); return 'Intensity: standard\n1. EPISODE PREMISE: the rematch.'; }
        wCalls.push('other'); return 'ONGOING \u2014 fine';
    },
};
CA.directorWatcherPass = true;
CA.directorTwoPass = true;
CA.directorMode = 'off';
CA.streaming = false;
ctx.chatMetadata['continuityCopilot'] = { director: null, directorEp: 0 };
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
const w1 = wCalls.join(',');
ok(w1 === 'directive,review,watcher', 'three-pass order: maker, showrunner, watcher (got: ' + w1 + ')');
ok(String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '').includes('WATCHER AIRED ONE'), 'the STORED directive is the watcher final cut');
ok(globalThis.__watcherUsr.includes('[SCREENING COPY') && globalThis.__watcherUsr.includes('SHOWRUNNER CUT ONE'), 'the showrunner cut travels to the couch as the screening copy');
ok(globalThis.__watcherSys.includes('MINIMAL CUT') && !globalThis.__watcherSys.includes('This episode is a RESTART'), 'fresh episode: watcher briefed for minimal cut, no restart addendum');
// empty watcher output ships the showrunner cut
wCalls.length = 0; watcherReturn = ''; srReturn = 'Intensity: standard\nSHOWRUNNER CUT TWO: fallback proof.';
ctx.chatMetadata['continuityCopilot'] = { director: null, directorEp: 0 };
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
const dW2 = String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '');
ok(wCalls.join(',') === 'directive,review,watcher' && dW2.includes('SHOWRUNNER CUT TWO') && !dW2.includes('WATCHER AIRED'), 'empty watcher pass falls back to the showrunner cut');
// toggle off: exactly two calls, no watcher
wCalls.length = 0; srReturn = 'Intensity: standard\nSHOWRUNNER CUT THREE: two-pass toggle proof.';
CA.directorWatcherPass = false;
ctx.chatMetadata['continuityCopilot'] = { director: null, directorEp: 0 };
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
ok(wCalls.join(',') === 'directive,review' && String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '').includes('SHOWRUNNER CUT THREE'), 'watcher toggle off restores the exact two-pass contract');
// restart: the watcher receives the never-aired warning
wCalls.length = 0; watcherReturn = 'Intensity: standard\nWATCHER AIRED FOUR: the road not taken, enjoyed.'; srReturn = 'Intensity: standard\nSHOWRUNNER CUT FOUR.';
CA.directorWatcherPass = true;
globalThis.__watcherSys = '';
console.log = logCap;
document.getElementById('cc_dirnew').click();
await sleep(400);
console.log = realLog;
ok(globalThis.__watcherSys.includes('This episode is a RESTART'), 'restart: the watcher is told the discarded directive never aired');
ok(String(((ctx.chatMetadata['continuityCopilot'] || {}).director || {}).text || '').includes('WATCHER AIRED FOUR'), 'restart flow ships the watcher final cut');

console.log('== v2.68.0 behavior: undo is drift-guarded (swipe / deletion / external memory / WI editor) ==');
// Drive the REAL paths end-to-end: stage cards through Send, apply through
// Apply-all, drift the target from OUTSIDE (swipe, delete, co-extension write,
// World-Info editor), then Undo. The pre-2.68 blind restore must be refused
// loudly and the drifted content must survive. A clean undo must still work.
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.directorMode = 'off';
CA.critiqueAuto = 0;
CA.critiqueOnEpisode = false;
CA.directorInjectPaused = true;
CA.critiqueInjectPaused = true;
const ccLogText = () => (document.getElementById('cc_log').children || []).map(k => String(k.textContent || '') + String(k.innerHTML || ''));
const clickFresh = (id) => {
    const b = document.getElementById(id);
    // Mock fidelity: the real DOM destroys and recreates these buttons on every
    // render (fresh listeners); the mock stub element accumulates them. Keep the
    // latest only, or one click fires every render generation at once.
    const arr = b._on.get('click') || [];
    if (arr.length > 1) b._on.set('click', arr.slice(-1));
    b.click();
};
const driveAsk = async (reply) => {
    ctx.ConnectionManagerRequestService = { sendRequest: async () => reply };
    document.getElementById('cc_input').value = 'please fix this';
    clickFresh('cc_send');
    await sleep(350);
    clickFresh('cc_applyall');
    await sleep(350);
};
// Positive control: with NO drift, undo still restores exactly.
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'The road was iron.' });
await driveAsk('<edits>[{"id":0,"find":"iron","replace":"steel"}]</edits>');
ok(ctx.chat[0].mes === 'The road was steel.', 'sim setup: chat edit applied through the real Apply-all path');
clickFresh('cc_undo');
await sleep(300);
ok(ctx.chat[0].mes === 'The road was iron.', 'clean undo (no drift) still restores the pre-apply text exactly');
// (a) Swipe drift.
ctx.chat.length = 0;
ctx.chat.push({ is_user: true, mes: 'hi' }, { is_user: false, mes: 'The sword was iron.' });
await driveAsk('<edits>[{"id":1,"find":"iron","replace":"steel"}]</edits>');
ok(ctx.chat[1].mes === 'The sword was steel.', 'sim setup: second chat edit applied');
ctx.chat[1].mes = 'The player rewrote this swipe entirely.';
clickFresh('cc_undo');
await sleep(300);
ok(ctx.chat[1].mes === 'The player rewrote this swipe entirely.', 'undo-after-swipe: the player\u2019s newer text survived \u2014 the blind restore was refused');
ok(ccLogText().some(t => /SKIPPED/.test(t) && /swipe \/ edit \/ reindex/.test(t)), 'undo-after-swipe: the refusal was loud and itemized in the panel');
// (b) Message deletion reindex.
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'zero' }, { is_user: false, mes: 'one' }, { is_user: false, mes: 'The gate was iron.' });
await driveAsk('<edits>[{"id":2,"find":"iron","replace":"steel"}]</edits>');
ok(ctx.chat[2].mes === 'The gate was steel.', 'sim setup: third chat edit applied');
ctx.chat.splice(0, 1);   // the user deleted message #0 \u2014 every later index shifts down
clickFresh('cc_undo');
await sleep(300);
ok(ctx.chat.length === 2 && ctx.chat[0].mes === 'one' && ctx.chat[1].mes === 'The gate was steel.', 'undo-after-deletion: no message received stale text after the reindex');
ok(ccLogText().some(t => /SKIPPED/.test(t) && /no longer exists/.test(t)), 'undo-after-deletion: the refusal was loud');
// (c) External memory write (Summaryception interop).
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
ctx.chatMetadata.summary_memory = 'The blade is iron.';
await driveAsk('<memedits>[{"path":"summary_memory","find":"iron","replace":"steel"}]</memedits>');
ok(String(ctx.chatMetadata.summary_memory) === 'The blade is steel.', 'sim setup: the memory edit applied');
ctx.chatMetadata.summary_memory += '\n[Summaryception] a new beat was logged.';
clickFresh('cc_undo');
await sleep(300);
ok(String(ctx.chatMetadata.summary_memory).includes('new beat was logged'), 'undo-after-external-write: the co-extension\u2019s newer memory survived');
ok(ccLogText().some(t => /summary_memory/.test(t) && /changed since the apply/.test(t)), 'undo-after-external-write: the refusal named the drifted key');
// (d) World-Info editor edit.
const wiStore = new Map();
ctx.loadWorldInfo = async (book) => { const d = wiStore.get(book); return d ? JSON.parse(JSON.stringify(d)) : null; };
ctx.saveWorldInfo = async (book, data) => { wiStore.set(book, JSON.parse(JSON.stringify(data))); return true; };
wiStore.set('gatebook', { entries: { '0': { uid: 0, key: ['blade'], keysecondary: [], comment: 'Blade', content: 'iron blade' } } });
CA.wiBooks = 'gatebook';   // wiCanEdit() requires at least one effective book
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
await driveAsk('<wiedits>[{"book":"gatebook","uid":0,"find":"iron","replace":"steel"}]</wiedits>');
ok(String(wiStore.get('gatebook').entries['0'].content) === 'steel blade', 'sim setup: the worldbook edit applied');
wiStore.get('gatebook').entries['0'].content = 'steel blade (polished by hand in the WI editor)';
wiStore.get('gatebook').entries['1'] = { uid: 1, key: ['extra'], keysecondary: [], comment: 'Extra', content: 'user-added entry' };
clickFresh('cc_undo');
await sleep(300);
const bookAfterUndo = wiStore.get('gatebook');
ok(String(bookAfterUndo.entries['0'].content).includes('polished by hand') && !!bookAfterUndo.entries['1'], 'undo-after-WI-editor-edit: hand edits and user-added entries survived \u2014 the blind whole-book restore was refused');
ok(ccLogText().some(t => /worldbook/.test(t) && /gatebook/.test(t) && /changed since the apply/.test(t)), 'undo-after-WI-editor-edit: the refusal named the worldbook');

console.log('== v2.68.0 behavior: Apply is re-entrancy safe (synchronous card claim) ==');
// A slow save opens the window the old code lost: two Apply-all clicks during
// the first run's network await must NOT create the entry twice.
wiStore.set('racebook', { entries: {} });
CA.wiBooks = 'racebook';
let saveGate = null;
ctx.saveWorldInfo = async (book, data) => { if (saveGate) await saveGate; wiStore.set(book, JSON.parse(JSON.stringify(data))); return true; };
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
clickFresh('cc_dismissall');   // isolate: earlier sims returned their cards to pending
await sleep(50);
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<wiedits>[{"book":"racebook","new_entry":true,"comment":"Canon","content":"the duke is dead","keys":["duke"]}]</wiedits>' };
document.getElementById('cc_input').value = 'add lore';
clickFresh('cc_send');
await sleep(350);
let releaseSave;
saveGate = new Promise(r => { releaseSave = r; });
clickFresh('cc_applyall');
await sleep(60);            // first run is now parked inside the slow save
clickFresh('cc_applyall');  // re-entrant click: must skip the claimed card, loudly
await sleep(60);
releaseSave();
await sleep(350);
saveGate = null;
const raceEntries = Object.keys(wiStore.get('racebook').entries).length;
ok(raceEntries === 1, 'double-click Apply-all during a slow save created exactly ONE worldbook entry (got ' + raceEntries + ')');
ok(ccLogText().some(t => /Already applying/.test(t)), 'the re-entrant click was told a run is in progress, not silently ignored');

console.log('== v2.68.0 behavior: fuzzy memory anchors must be unique across ALL fields ==');
// Two ledger fields differ by ONE word from the anchor (fuzzy ~0.89, no exact
// match): the old first-match-wins fallback would have written into whichever
// field enumerated first. The collect-then-decide guard must refuse — and a
// path-scoped retry of the same anchor must apply precisely.
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
clickFresh('cc_dismissall');
await sleep(50);
ctx.chatMetadata.summary_ledger = {
    jillian: { state: 'Jillian is at the academy library, studying wards.' },
    bram: { state: 'Jillian is at the academy library, studying tomes.' },
};
await driveAsk('<memedits>[{"find":"Jillian is at the academy library, studying scrolls.","replace":"Jillian is at the academy observatory, studying wards."}]</memedits>');
ok(String(ctx.chatMetadata.summary_ledger.jillian.state).includes('library') && String(ctx.chatMetadata.summary_ledger.bram.state).includes('library'), 'cross-field fuzzy anchor: BOTH lookalike fields untouched \u2014 first-match corruption refused');
ok(ccLogText().some(t => /No edits applied/.test(t)), 'cross-field fuzzy anchor: the refusal was loud (failed card + explanation), not a silent skip');
await driveAsk('<memedits>[{"path":"summary_ledger.jillian.state","find":"Jillian is at the academy library, studying scrolls.","replace":"Jillian is at the academy observatory, studying wards."}]</memedits>');
ok(String(ctx.chatMetadata.summary_ledger.jillian.state).includes('observatory') && String(ctx.chatMetadata.summary_ledger.bram.state).includes('library'), 'the same anchor with an explicit path applied to exactly the named field');

console.log('== v2.68.0 invariants: card hand-edit is payload-channel aware ==');
// The ✎ viewer used to String() every payload: structured replaces died as
// "[object Object]" and append cards edited a field the apply path never reads.
ok(SRC.includes('function cardPayloadSpec('), 'card hand-edit routes through a payload-channel spec');
ok(SRC.includes('const isAppend = edit.append !== undefined'), 'append cards edit the append channel, not the dead replace field');
ok(SRC.includes('saved back as a structured value'), 'structured replaces are presented as JSON');
ok(SRC.includes("throw new Error('expected a JSON array or object')"), 'structured hand-edit rejects non-object JSON instead of corrupting the payload');
ok(SRC.includes("catch (je) {") && SRC.includes('the proposal was left unchanged'), 'invalid JSON in the viewer fails loud and leaves the card unchanged');
ok(!SRC.includes("showViewer(title, String(e.replace ?? '')"), 'the blind String(e.replace) hand-edit path is gone');

console.log('== v2.68.0 invariants: the low-severity hardening pack ==');
ok(SRC.includes("your message is back in the box"), '/cc while busy: typed text is parked back in the input, never dropped silently');
ok(SRC.includes('pendingAutoDirectorRetry = true; return;') && (SRC.match(/releaseAutoDirectorRetry\(\);/g) || []).length >= 7, 'auto-director skip-while-running sets a retry flag, drained by every running-releasing finally (found ' + (SRC.match(/releaseAutoDirectorRetry\(\);/g) || []).length + ' drains, need >= 7)');
ok(SRC.includes('await streamIt.return?.()'), 'a stopped stream is formally closed (iterator return), not abandoned');
ok(SRC.includes('INIT_MAX_ATTEMPTS') && SRC.includes('setTimeout(init, 2000)') && SRC.includes('inited = true;\n            console.log(LOG'), 'init failure is retryable with phase guards; inited set only on success');
ok(SRC.includes('const UNDO_CAP = 50') && SRC.includes('function pushUndoBatch(') && !SRC.includes('undoStack.push({'), 'undo history is bounded and all pushes route through the cap');
ok(!SRC.includes("writable at path cc_critique) ---"), 'cc_critique is no longer duplicated into the copilot context (author-level block carries it)');
ok(SRC.includes('function wiRoleNum(') && SRC.includes('role: o.role !== undefined ? wiRoleNum(o.role) : null,'), 'worldbook role is validated/mapped to the numeric enum at parse time');
ok(SRC.includes('replace(/["\'`\\\\{}[\\]]/g, \'\')'), 'worldbook names are sanitized before slash-command interpolation');
ok(SRC.includes('concluded by advancing (') && SRC.includes('no [EPISODE_END] marker was emitted'), 'Next/Seed over a live episode records the skipped conclusion in the ledger');
ok(SRC.includes('for (let guard = 0; guard < 20; guard++)'), 'stripBlocks removes EVERY block per tag (bounded), not just the first');

console.log('== v2.68.0 behavior: send() while busy is loud and loses nothing ==');
let slow2;
ctx.ConnectionManagerRequestService = { sendRequest: () => new Promise(r => { slow2 = () => r('ok'); }) };
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
document.getElementById('cc_input').value = 'first question';
clickFresh('cc_send');
await sleep(80);
document.getElementById('cc_input').value = '';
const toastsBeforeBusy = toasts.length;
clickFresh('cc_audit');   // a send() entry point while running — must be loud + preserve text
await sleep(50);
ok(toasts.length > toastsBeforeBusy && /back in the box/.test(String(toasts[toasts.length - 1])), 'send() while busy is loud, not a silent drop');
ok(String(document.getElementById('cc_input').value).length > 0, 'send() while busy parked the text back in the input box');
document.getElementById('cc_input').value = '';
slow2();
await sleep(300);

console.log('== v2.68.0 behavior: auto-director skipped mid-run retries when the lock releases ==');
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
CA.directorMode = 'auto';
CA.directorTwoPass = false;
CA.directorWatcherPass = false;
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'E1 done.', episode: 1, concluded: true, ts: 1 }, directorEp: 1 };
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
const seq = [];
let slowRelease;
ctx.ConnectionManagerRequestService = {
    sendRequest: (pid, messages) => {
        const sys = (messages && messages[0] && messages[0].content) || '';
        if (sys.includes('expert story director')) { seq.push('directive'); return Promise.resolve('Intensity: standard\n1. EPISODE PREMISE \u2014 chained after the lock released.'); }
        seq.push('copilot');
        return new Promise(r => { slowRelease = () => r('copilot answer'); });
    },
};
document.getElementById('cc_input').value = 'question while concluded';
clickFresh('cc_send');
await sleep(100);   // the copilot run now holds `running`
for (const f of handlers.get('MESSAGE_RECEIVED') || []) await f(ctx.chat.length - 1);  // auto-direct skips: lock held
ok(seq.join(',') === 'copilot', 'auto-direct skipped while the lock was held (only the copilot call fired)');
slowRelease();
await sleep(400);   // the finally drains the retry flag -> maybeAutoDirector -> next directive
ok(seq.join(',') === 'copilot,directive', 'the skipped auto-direct fired when the lock released (got: ' + seq.join(',') + ')');
const dRetry = (ctx.chatMetadata['continuityCopilot'] || {}).director || {};
ok(dRetry.episode === 2 && !dRetry.concluded && String(dRetry.text || '').includes('chained after the lock released'), 'the retried chain stored a live episode 2');

console.log('== v2.69.0 invariants: the stop flag belongs to the RUN, not to one call ==');
// Regression: `stopRequested` was cleared at the top of callLLM. A run makes MANY
// calls (fetch rounds, worldbook reads, think-recovery, three director passes), so
// a Stop pressed in any gap between them was erased and the run opened a request
// the user had already cancelled.
ok(/function beginRun\(\) \{\n        running = true;\n        stopRequested = false;\n        setBusy\(true\);\n    \}/.test(SRC), 'beginRun() is the one place a run starts: takes the lock AND clears the stop flag');
ok((SRC.match(/\n        running = true;/g) || []).length === 1, 'the lock is taken in exactly one place (beginRun), nowhere else');
ok((SRC.match(/\n        beginRun\(\);/g) || []).length === 9, 'all 9 run entrypoints route through beginRun (found ' + (SRC.match(/\n        beginRun\(\);/g) || []).length + ', need 9)');   // +1 in v2.72 (runDeepAudit), +1 in v2.73 (runMemoryPass)
ok(!/const maxTok = [^\n]*\n        stopRequested = false;/.test(SRC), 'callLLM no longer clears the stop flag');
ok(/if \(stopRequested\) return '';\n        try \{ abortCtl = new AbortController/.test(SRC), 'callLLM refuses to open a request when the run is already stopped');

console.log('== v2.69.0 invariants: undo cannot lose a batch or write to the wrong chat ==');
ok(SRC.includes('async function undoRestore(batch)'), 'the undo restore body is separable from the pop, so a throw is catchable');
ok(/\} catch \(err\) \{[\s\S]{0,500}?undoStack\.push\(batch\);/.test(SRC), 'a throw mid-undo puts the batch BACK instead of consuming it');
ok(/const md = chatAt\.md \|\| c\.chatMetadata \|\| c\.chat_metadata;/.test(SRC), 'undo restores memory into the CAPTURED chat, not whatever chat is open now');

console.log('== v2.69.0 invariants: no throw escapes a lock acquisition ==');
ok(/attachMsgIcons\(div, kind, hidx\);\n[\s\S]{0,400}?\n        if \(!log\) return div;/.test(SRC), 'addBubble degrades when the panel is absent instead of throwing past the caller\u2019s lock');
ok(/attachMsgIcons\(div, 'ai', hidx\);\n        if \(!log\) return div;/.test(SRC), 'addAiBubble degrades when the panel is absent');
ok(SRC.includes('function applyRunFailed(') && (SRC.match(/\.catch\(applyRunFailed\)/g) || []).length === 2, 'both fire-and-forget applyEdits call sites surface a rejected run (found ' + (SRC.match(/\.catch\(applyRunFailed\)/g) || []).length + ', need 2)');

console.log('== v2.69.0 invariants: the auto-director retry is armed only when it can fire ==');
{
    const mad = SRC.slice(SRC.indexOf('function maybeAutoDirector()'), SRC.indexOf('async function onEpisodeConcluded'));
    const iProfile = mad.indexOf('if (!settings.profileId) return;');
    const iPaused = mad.indexOf('if (settings.directorInjectPaused) return;');
    const iRunning = mad.indexOf('if (running) { pendingAutoDirectorRetry = true; return; }');
    ok(iProfile > 0 && iPaused > 0 && iRunning > iProfile && iRunning > iPaused, 'running (the only transient condition) is tested AFTER profile and paused');
}

console.log('== v2.69.0 behavior: a Stop pressed BETWEEN calls opens no further request ==');
CA.directorMode = 'off';
CA.critiqueAuto = 0;
CA.critiqueOnEpisode = false;
CA.fetchRounds = 3;
wiStore.set('stopbook', { entries: { '0': { uid: 0, key: ['x'], keysecondary: [], comment: 'X', content: 'body text' } } });
CA.wiBooks = 'stopbook';
ctx.chatMetadata['continuityCopilot'] = {};
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
let stopRunCalls = 0;
ctx.ConnectionManagerRequestService = {
    sendRequest: async () => {
        stopRunCalls++;
        return stopRunCalls === 1 ? '<wifetch>["stopbook#0"]</wifetch>' : 'THIS SECOND CALL MUST NOT HAPPEN';
    },
};
const realLoadWI = ctx.loadWorldInfo;
ctx.loadWorldInfo = async (book) => {
    // The user hits Stop during the worldbook read — precisely the gap between the
    // round's stop-check and the next callLLM. This is the window the old code erased.
    clickFresh('cc_send');
    return realLoadWI(book);
};
document.getElementById('cc_input').value = 'read the worldbook then answer';
clickFresh('cc_send');
await sleep(600);
ctx.loadWorldInfo = realLoadWI;
ok(stopRunCalls === 1, 'Stop during the inter-call gap prevented the next request (requests fired: ' + stopRunCalls + ', must be 1)');
ok(ccLogText().some(t => /Generation stopped/.test(t)), 'the stopped run announced itself instead of continuing silently');

console.log('== v2.69.0 behavior: a throw mid-undo keeps the batch, and the retry succeeds ==');
CA.fetchRounds = 0;
CA.wiBooks = 'gatebook';
wiStore.set('gatebook', { entries: { '0': { uid: 0, key: ['blade'], keysecondary: [], comment: 'Blade', content: 'iron blade' } } });
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });
await driveAsk('<wiedits>[{"book":"gatebook","uid":0,"find":"iron","replace":"steel"}]</wiedits>');
ok(String(wiStore.get('gatebook').entries['0'].content).includes('steel'), 'sim setup: the worldbook edit applied through the real Apply-all path');
// An unexpected throw inside the restore: a book whose entries cannot be serialized.
const circular = { entries: {} };
circular.entries.self = circular.entries;
ctx.loadWorldInfo = async () => circular;
const undoLogBefore = ccLogText().length;
clickFresh('cc_undo');
await sleep(400);
ok(ccLogText().slice(undoLogBefore).some(t => /batch was kept/.test(t)), 'the failed undo said so and kept the batch instead of swallowing it');
ok(String(wiStore.get('gatebook').entries['0'].content).includes('steel'), 'the failed undo changed nothing');
ctx.loadWorldInfo = realLoadWI;
clickFresh('cc_undo');
await sleep(400);
ok(String(wiStore.get('gatebook').entries['0'].content).includes('iron'), 'pressing Undo again after the failure restored the pre-apply worldbook');
ok(!ccLogText().slice(undoLogBefore).some(t => /Nothing to undo/.test(t)), 'the batch was never lost — the retry found it on the stack');


console.log('== v2.71.0 invariants: one coercion for every numeric setting ==');
// Root cause of the depth-0 bug: `Number(x) || fallback` collapses three
// distinct states (a real 0, a blank field, garbage) into one. Prove the helper
// exists, that it is the ONLY thing reading these settings, and that no
// falsy-default survives on a field whose UI declares min="0".
ok(SRC.includes('function numSetting(raw, fallback, lo, hi)'), 'the canonical numeric coercion helper exists');
const badNumDefaults = (SRC.match(/Number\((?:settings|el\()[^)]*\)[^;\n]*\|\|\s*[1-9]/g) || []);
ok(badNumDefaults.length === 0, 'no numeric setting is read with a truthy-only fallback any more' + (badNumDefaults.length ? ' — found: ' + badNumDefaults.join(' | ') : ''));
ok(!SRC.includes(".value ?? 300"), '?? is no longer applied to a DOM .value (which is never null, so it never fired)');
const numUses = (SRC.match(/numSetting\(/g) || []).length;
ok(numUses >= 16, 'every numeric read and write routes through the helper (found ' + numUses + ' uses, need >= 16)');

console.log('== v2.71.0 behavior: 0, blank and garbage are three different answers ==');
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.directorMode = 'off';
CA.critiqueAuto = 0;
CA.critiqueOnEpisode = false;
CA.directorInjectPaused = false;
CA.critiqueInjectPaused = false;
ctx.chatMetadata['continuityCopilot'] = { director: { text: 'BEATS', episode: 1, concluded: false, ts: 1 }, directorEp: 1 };
ctx.chatMetadata.cc_critique = 'NORTH STAR: sharpen it.';
const setNum = (id, v) => { document.getElementById(id).value = v; };
const saveSettings = () => { clickFresh('cc_saveset'); CA.profileId = 'gate-profile'; };

// (a) A deliberate 0 must survive. Depth 0 = inject directly above the reply;
// the UI declares min="0", so refusing it was the UI lying to the user.
setNum('cc_dir_depth', '0'); setNum('cc_crit_depth', '0');
setNum('cc_llm_timeout', '0'); setNum('cc_think_retries', '0');
saveSettings();
ok(CA.directorDepth === 0, 'a typed director depth of 0 is stored as 0 (got ' + JSON.stringify(CA.directorDepth) + ')');
ok(CA.critiqueDepth === 0, 'a typed critique depth of 0 is stored as 0 (got ' + JSON.stringify(CA.critiqueDepth) + ')');
ok(CA.llmTimeoutSec === 0, 'a typed stall timeout of 0 is honoured as "off" (got ' + JSON.stringify(CA.llmTimeoutSec) + ')');
ok(CA.thinkRetries === 0, 'typed retries of 0 is honoured as "off" (got ' + JSON.stringify(CA.thinkRetries) + ')');

// And a stored 0 must reach the actual injection call, not just the settings object.
const depthSeen = [];
const realSEP71 = ctx.setExtensionPrompt;
ctx.setExtensionPrompt = (key, value, pos, depth, scan, role) => { depthSeen.push({ key: String(key), depth }); realSEP71.call(ctx, key, value, pos, depth, scan, role); };
for (const f of handlers.get('CHAT_CHANGED') || []) f();
ctx.setExtensionPrompt = realSEP71;
const dDepth = (depthSeen.find(x => x.key === 'cc_director') || {}).depth;
const cDepth = (depthSeen.find(x => x.key === 'cc_critique_inject') || {}).depth;
ok(dDepth === 0, 'the director injection really lands at depth 0 (got ' + JSON.stringify(dDepth) + ')');
ok(cDepth === 0, 'the editor injection really lands at depth 0 (got ' + JSON.stringify(cDepth) + ')');

// (b) A CLEARED box is "unset", not 0 — it must fall back to the default. The
// pre-2.71 read turned an empty stall-timeout box into 0, silently switching OFF
// the watchdog that stops one hung request from wedging every button.
setNum('cc_dir_depth', ''); setNum('cc_crit_depth', '');
setNum('cc_llm_timeout', ''); setNum('cc_think_retries', '');
setNum('cc_recent', ''); setNum('cc_rounds', ''); setNum('cc_maxtok', '');
saveSettings();
ok(CA.llmTimeoutSec === 300, 'clearing the stall-timeout box restores the default, it does NOT disable the watchdog (got ' + JSON.stringify(CA.llmTimeoutSec) + ')');
ok(CA.thinkRetries === 2, 'clearing the retries box restores the default, it does NOT disable auto-recovery (got ' + JSON.stringify(CA.thinkRetries) + ')');
ok(CA.directorDepth === 3 && CA.critiqueDepth === 8, 'clearing the depth boxes restores their defaults (got ' + CA.directorDepth + '/' + CA.critiqueDepth + ')');
ok(CA.recentFull === 8 && CA.fetchRounds === 3 && CA.maxTokens === 8192, 'clearing the context boxes restores their defaults (got ' + CA.recentFull + '/' + CA.fetchRounds + '/' + CA.maxTokens + ')');

// (c) Garbage falls back; out-of-range clamps to the UI's declared bounds.
setNum('cc_dir_depth', 'abc'); setNum('cc_crit_depth', '999'); setNum('cc_maxtok', '99999');
saveSettings();
ok(CA.directorDepth === 3, 'garbage in a numeric box falls back to the default (got ' + JSON.stringify(CA.directorDepth) + ')');
ok(CA.critiqueDepth === 30, 'an over-range value clamps to the UI max (got ' + JSON.stringify(CA.critiqueDepth) + ')');
ok(CA.maxTokens === 32768, 'an over-range token budget clamps to the provider ceiling (got ' + JSON.stringify(CA.maxTokens) + ')');
setNum('cc_dir_depth', '3'); setNum('cc_crit_depth', '8'); setNum('cc_maxtok', '8192');
setNum('cc_llm_timeout', '300'); setNum('cc_think_retries', '2');
setNum('cc_recent', '8'); setNum('cc_rounds', '3');
saveSettings();

console.log('== v2.71.0 invariants: an undo record matches the granularity of its edit ==');
ok(SRC.includes('function memBackup(keyBackups, md, tokens)'), 'memory backups are taken at the NODE, not at the root key');
ok(SRC.includes('function memPathParent(md, tokens)'), 'undo resolves the node through a shared path walker');
ok(!/keyBackups\.set\(\s*(?:hit\.)?rootKey/.test(SRC), 'no backup site still snapshots a whole root key');
ok(SRC.includes('memValueHash(loc.parent[loc.key])'), 'the undo drift fingerprint is NODE-scoped, not root-scoped');
ok(SRC.includes("refused.push('memory \"' + label + '\" no longer exists at that path"), 'a vanished path is refused, never rebuilt');
ok(SRC.includes("'Undo restored NOTHING on '"), 'a fully-refused undo says so instead of printing a success line');

console.log('== v2.71.0 behavior: undo restores the field it edited, and only that field ==');
CA.directorInjectPaused = true;
CA.critiqueInjectPaused = true;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, mes: 'story reply' });

// (a) The extension's OWN metadata root. loadSettings advertises
// continuityCopilot.director.text as the editable path, and every apply writes a
// receipt line into that same root — so a root-scoped fingerprint drifted 100% of
// the time and the undo could never fire.
ctx.chatMetadata['continuityCopilot'].director = { text: 'ORIGINAL BEATS', episode: 4, concluded: false, ts: 1 };
await driveAsk('<memedits>[{"path":"continuityCopilot.director.text","replace":"REWRITTEN BEATS"}]</memedits>');
ok(ctx.chatMetadata['continuityCopilot'].director.text === 'REWRITTEN BEATS', 'sim setup: the directive edit applied through the real Apply-all path');
const histBeforeUndo = (ctx.chatMetadata['continuityCopilot'].sessions[0].history || []).length;
const logAt71 = ccLogText().length;
clickFresh('cc_undo');
await sleep(400);
ok(ctx.chatMetadata['continuityCopilot'].director.text === 'ORIGINAL BEATS', 'undo restored the directive text (got ' + JSON.stringify(ctx.chatMetadata['continuityCopilot'].director.text) + ')');
ok(!ccLogText().slice(logAt71).some(t => /SKIPPED/.test(t)), 'the undo did not falsely blame drift on our own receipt line');
ok((ctx.chatMetadata['continuityCopilot'].sessions[0].history || []).length >= histBeforeUndo, 'the undo did NOT roll the session history back — only the edited node was written');
ok(ctx.chatMetadata['continuityCopilot'].director.episode === 4, 'sibling fields of the edited node survived the undo');

// (b) A co-extension rewriting a DIFFERENT field of the same root must not block
// an undo of the field we actually edited.
ctx.chatMetadata.summaryception = { ledger: 'Jillian is at the academy.', threads: 'thread one' };
await driveAsk('<memedits>[{"path":"summaryception.ledger","find":"at the academy","replace":"on the train"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.includes('on the train'), 'sim setup: the memory edit applied');
ctx.chatMetadata.summaryception.threads = 'thread one\nthread two (written by the memory extension after the apply)';
clickFresh('cc_undo');
await sleep(400);
ok(ctx.chatMetadata.summaryception.ledger.includes('at the academy'), 'undo restored the edited field despite a sibling write under the same root');
ok(ctx.chatMetadata.summaryception.threads.includes('thread two'), 'the co-extension\u2019s sibling write SURVIVED the undo (a root-scoped restore would have eaten it)');

// (c) Drift on the edited field itself is still refused, loudly, with nothing
// overwritten. Cards a previous undo returned to pending must be cleared first,
// or Apply-all folds them into this batch and it is no longer fully-refused.
const dismissPending = () => { const b = document.getElementById('cc_dismissall'); if (b) clickFresh('cc_dismissall'); };
dismissPending();
await driveAsk('<memedits>[{"path":"summaryception.ledger","find":"at the academy","replace":"in the infirmary"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.includes('in the infirmary'), 'sim setup: the second memory edit applied');
ctx.chatMetadata.summaryception.ledger = 'Jillian is in the infirmary, and someone else edited this line.';
const logAtDrift = ccLogText().length;
clickFresh('cc_undo');
await sleep(400);
ok(ctx.chatMetadata.summaryception.ledger.includes('someone else edited this line'), 'a drifted field is not overwritten by a stale snapshot');
const driftLines = ccLogText().slice(logAtDrift);
ok(driftLines.some(t => /SKIPPED/.test(t) && /summaryception\.ledger/.test(t)), 'the refusal names the exact FIELD, not just the root key');
ok(driftLines.some(t => /restored NOTHING/.test(t)), 'a fully-refused undo reports that nothing was restored instead of claiming success');
ok(!driftLines.some(t => /^Undid edits on/.test(t)), 'no contradictory success receipt was printed alongside the refusal');

// (d) A vanished path refuses instead of resurrecting a deleted branch.
dismissPending();
ctx.chatMetadata.summaryception = { ledger: 'Jillian is at the academy.' };
await driveAsk('<memedits>[{"path":"summaryception.ledger","find":"at the academy","replace":"on the train"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.includes('on the train'), 'sim setup: the third memory edit applied');
delete ctx.chatMetadata.summaryception;
const logAtGone = ccLogText().length;
clickFresh('cc_undo');
await sleep(400);
ok(ctx.chatMetadata.summaryception === undefined, 'a root the user deleted is NOT resurrected by an undo');
ok(ccLogText().slice(logAtGone).some(t => /no longer exists at that path/.test(t)), 'the vanished path is refused by name');

// (e) A MIXED batch — one field restorable, one drifted — reports both truthfully:
// the success line covers what really landed, the skip list names what did not.
dismissPending();
ctx.chatMetadata.summaryception = { ledger: 'Jillian is at the academy.' };
ctx.chatMetadata['continuityCopilot'].director = { text: 'ORIGINAL BEATS', episode: 9, concluded: false, ts: 1 };
await driveAsk('<memedits>[{"path":"summaryception.ledger","find":"at the academy","replace":"on the train"},{"path":"continuityCopilot.director.text","replace":"REWRITTEN"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.includes('on the train') && ctx.chatMetadata['continuityCopilot'].director.text === 'REWRITTEN', 'sim setup: both fields of the mixed batch applied');
ctx.chatMetadata.summaryception.ledger = 'externally rewritten since the apply';
const logAtMixed = ccLogText().length;
clickFresh('cc_undo');
await sleep(400);
const mixedLines = ccLogText().slice(logAtMixed);
ok(ctx.chatMetadata['continuityCopilot'].director.text === 'ORIGINAL BEATS', 'the restorable field of a mixed batch was restored');
ok(ctx.chatMetadata.summaryception.ledger === 'externally rewritten since the apply', 'the drifted field of a mixed batch was left alone');
ok(mixedLines.some(t => /^Undid edits on/.test(t)) && mixedLines.some(t => /SKIPPED 1 item/.test(t)), 'a mixed batch reports the restore AND names the one it skipped');
ok(!mixedLines.some(t => /restored NOTHING/.test(t)), 'a mixed batch does not claim it restored nothing');

// (f) DEEP path via the memory-wide search (no explicit "path"): the token trail
// walkFind builds must resolve to exactly the container it mutated, or the undo
// would write to a different node than the apply did.
dismissPending();
ctx.chatMetadata.summaryception = { ledger: { chars: [{ name: 'Jillian', state: 'Jillian waits at the academy gate.' }, { name: 'Silas', state: 'Silas trains alone.' }] } };
await driveAsk('<memedits>[{"find":"waits at the academy gate","replace":"waits at the duel field"}]</memedits>');
ok(ctx.chatMetadata.summaryception.ledger.chars[0].state.includes('duel field'), 'sim setup: a deeply nested array field was edited via memory-wide search');
ctx.chatMetadata.summaryception.ledger.chars[1].state = 'Silas trains with the registrar.';   // co-extension writes a SIBLING array element
clickFresh('cc_undo');
await sleep(400);
ok(ctx.chatMetadata.summaryception.ledger.chars[0].state.includes('academy gate'), 'undo restored the exact nested array element it edited');
ok(ctx.chatMetadata.summaryception.ledger.chars[1].state.includes('registrar'), 'the sibling array element written after the apply survived the undo');

// (g) A key this extension AUTO-CREATED is deleted again by the undo, not left
// behind as an empty string the user never had.
dismissPending();
delete ctx.chatMetadata.note_prompt;
await driveAsk('<memedits>[{"path":"note_prompt","replace":"Keep the tone dry."}]</memedits>');
ok(ctx.chatMetadata.note_prompt === 'Keep the tone dry.', 'sim setup: writing to an absent note_prompt created it');
clickFresh('cc_undo');
await sleep(400);
ok(!Object.prototype.hasOwnProperty.call(ctx.chatMetadata, 'note_prompt'), 'undo removed the key the apply created, rather than leaving an empty string behind');

console.log('== v2.72.0: a message is served WHOLE, or it says it was not ==');
// Regression this pack exists for: fullTextOf did `.slice(0, 8000)` with NO marker.
// Every long scene reached the model as a mid-word stump LABELLED as its full text,
// so the model reasoned about where the message ENDED from a boundary the tool
// invented — and each edit moved that boundary and "revealed" more shrapnel.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.fullTextCap = 0;
CA.recentFull = 1;

const BIG_TAIL = 'THE_REAL_ENDING_MARKER</details>';
const bigMes = 'A'.repeat(20000) + BIG_TAIL;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'Narrator', mes: bigMes });

let captured = [];
const capture = (reply) => ({ sendRequest: async (pid, messages) => { captured.push(messages.map(m => String(m.content || '')).join('\n')); return reply; } });

captured = [];
ctx.ConnectionManagerRequestService = capture('nothing to fix');
document.getElementById('cc_input').value = 'read it';
clickFresh('cc_send');
await sleep(350);
const ctxSent = captured.join('\n');
ok(ctxSent.includes(BIG_TAIL), 'a 20k-char message reaches the model with its REAL ending intact (the 8000-char silent clip is gone)');
ok(ctxSent.includes('--- #0 [Narrator] \u2014 ' + bigMes.length + ' chars, COMPLETE'), 'the header states the exact character count (' + bigMes.length + ') and the verdict COMPLETE');
ok(ctxSent.includes('COMPLETE means COMPLETE'), 'the non-editable message-text contract ships with every request');

// With a cap deliberately set, the text is served in PARTS with a loud banner —
// never as a silent stump. The banner must forbid structural conclusions.
CA.fullTextCap = 5000;
captured = [];
ctx.ConnectionManagerRequestService = capture('ok');
document.getElementById('cc_input').value = 'read it again';
clickFresh('cc_send');
await sleep(350);
const capped = captured.join('\n');
ok(capped.includes('PART 1 OF ' + Math.ceil(bigMes.length / 5000) + ' (chars 1\u20135000 of ' + bigMes.length + '), INCOMPLETE'), 'an over-cap message is served as a numbered PART with exact character bounds');
ok(/CUT \u2014 NOT the whole message/.test(capped) && capped.includes(String(bigMes.length - 5000) + ' follow it'), 'the cut banner states how many characters are still missing (' + (bigMes.length - 5000) + ')');
ok(!capped.includes(BIG_TAIL), 'sim setup: part 1 genuinely does not contain the tail');
ok(/<fetch>\["0#2"\]<\/fetch>/.test(capped), 'the banner hands the model the exact ref for the next part');

// And the part ref actually resolves: asking for 0#5 serves the LAST slice.
captured = [];
let turn = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { captured.push(messages.map(m => String(m.content || '')).join('\n')); return (turn++ === 0) ? '<fetch>["0#5"]</fetch>' : 'done'; } };
document.getElementById('cc_input').value = 'get the end';
clickFresh('cc_send');
await sleep(500);
ok(captured.join('\n').includes(BIG_TAIL), 'a part fetch ("0#5") serves the final slice, so the true ending is reachable under a cap');
CA.fullTextCap = 0;

console.log('== v2.72.0: a short serve is never silent ==');
// parseFetch used to `.slice(0, 15)` the requested ids: the model asked for 20,
// got 15, and was never told which 5 it had not seen — the same lie in a new place.
ctx.chat.length = 0;
for (let i = 0; i < 40; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'scene ' + i });
captured = [];
turn = 0;
const wanted = JSON.stringify(Array.from({ length: 35 }, (_, i) => i));
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { captured.push(messages.map(m => String(m.content || '')).join('\n')); return (turn++ === 0) ? ('<fetch>' + wanted + '</fetch>') : 'done'; } };
document.getElementById('cc_input').value = 'read a lot';
clickFresh('cc_send');
await sleep(500);
const served = captured.join('\n');
ok(/id\(s\) in that request were NOT served/.test(served), 'over-cap fetch ids are reported back instead of silently dropped');
ok(/Not served: #30, #31, #32, #33, #34/.test(served), 'the unserved ids are named exactly');

console.log('== v2.72.0: the structure scanner proves what a reader was guessing ==');
// The literal shape that cost an evening: turn 217 carrying turn 215's Plot
// Momentum block as well as its own, plus a severed fragment welded to the tag.
const BROKEN = [
    '<details>', '<summary>Plot Momentum</summary>',
    '- NPC Agenda: Cersei seals the secret and binds him to her wholly, whatever it costs her.',
    '- Physics: the queen\u2019s chambers, rain on the glass, a guard posted outside the door.',
    '- Scene Pacing: Slow Burn', '</details>',
    '<details>', '<summary>Plot Momentum</summary>',
    '- NPC Agenda: Cersei seals the secret and binds him to her wholly, whatever it costs her.',
    '- Physics: the queen\u2019s chambers, rain on the glass, a guard posted outside the door.',
    '- Scene Pacing: Aftermath', '</details>s him in the afterglow, extracting promises.',
].join('\n');
const CLEAN = [
    '<details>', '<summary>Plot Momentum</summary>',
    '- NPC Agenda: Tywin sends ravens before the names leak, and counts the cost of each one.',
    '- Physics: the Tower of the Hand at dusk, a scribe waiting, the city loud below the window.',
    '- Scene Pacing: Aftermath', '</details>',
].join('\n');

ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'prose only, no machine blocks at all.' });
ctx.chat.push({ is_user: false, name: 'N', mes: CLEAN });
ctx.chat.push({ is_user: false, name: 'N', mes: BROKEN });

captured = [];
ctx.ConnectionManagerRequestService = capture('WINDOW CLEAN');
document.getElementById('cc_input').value = '#m structure';
clickFresh('cc_send');
await sleep(700);
const flags = captured.join('\n');
const scanLog = ccLogText().join('\n');
ok(/duplicate-block/.test(flags) && /share the summary label "Plot Momentum"/.test(flags), 'the scanner names the DUPLICATED block by its summary label — the "double details"');
ok(/tail-after-block/.test(flags) && /welded directly onto the final <\/details>/.test(flags), 'the scanner names the fragment welded onto the closing tag');
ok(/#2 \[N\]/.test(flags) && !/#1 \[N\]/.test(flags), 'only the broken message is flagged — the clean one and the prose-only one are not');
ok(/STRUCTURE FLAGS — proven by a code scan/.test(flags), 'the flags reach the model as facts, not as something to re-derive');
ok(/Structure: 1 message\(s\) carry provable faults/.test(scanLog), 'the user is told which messages are broken before any model call');

console.log('== v2.72.0: deep audit runs every pass and resumes ==');
dismissPending();
ctx.chat.length = 0;
for (let i = 0; i < 12; i++) ctx.chat.push({ is_user: i % 2 === 1, name: 'N', mes: 'Scene ' + i + ': the road was iron.' });
ctx.chatMetadata.summary_memory = 'Jillian is at the academy. (covers chat messages #0 to #3)';
CA.auditWindow = 4;
CA.auditFetchRounds = 0;

const passes = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 1 of 4')) { passes.push('structure'); return 'fixed'; }
        if (all.includes('PASS 2 of 4')) { passes.push('continuity'); return 'Scene 3 contradicts the memory.\n<edits>[{"id":3,"find":"iron","replace":"steel"}]</edits>'; }
        if (all.includes('PASS 3 of 4')) { passes.push('memory'); return 'Snippet 2 looks thin.\n<verify>[3]</verify>'; }
        if (all.includes('PASS 4 of 4')) { passes.push('verify'); return 'DOUBTS RESOLVED'; }
        passes.push('other'); return 'x';
    },
};
document.getElementById('cc_input').value = '#m';
clickFresh('cc_send');
await sleep(1400);
ok(passes.filter(p => p === 'continuity').length === 3, 'the continuity pass walked the WHOLE 12-message log in 4-message windows (got ' + passes.filter(p => p === 'continuity').length + ')');
ok(passes.includes('memory') && passes.includes('verify'), 'the memory pass ran unasked, and the verify pass fired because it raised a doubt');
ok(!passes.includes('other'), 'every audit call carried one of the four pass contracts');
const auditLog = ccLogText().join('\n');
ok(/Deep audit complete/.test(auditLog), 'the audit ends with a consolidated verdict');
ok((document.getElementById('cc_cards') ? true : true) && ccLogText().join('\n').includes('CONTINUITY'), 'window findings are reported in the transcript');

console.log('== v2.72.0: routing, contract and stored-default migrations ==');
ok(/^#m\b/.test('#m from 180') && !/^#m\b/.test('#memory audit'), 'the #m route cannot swallow a longer tag like #memory');
CA.systemPrompt = 'MY OWN CUSTOM PROMPT. USER_EDIT_RULE';
captured = [];
ctx.ConnectionManagerRequestService = capture('ok');
document.getElementById('cc_input').value = 'hello';
clickFresh('cc_send');
await sleep(350);
ok(captured.join('\n').includes('COMPLETE means COMPLETE'), 'the completeness contract survives a fully CUSTOMIZED system prompt (it lives outside the editable one)');
CA.systemPrompt = SRC.match(/const LEGACY_SYSTEM_PROMPT_V271 = /) ? CA.systemPrompt : CA.systemPrompt;
ok(SRC.includes('const LEGACY_SYSTEM_PROMPT_V271 = DEFAULT_SYSTEM_PROMPT'), 'a stored 2.71 system prompt has a legacy witness to upgrade from');
ok(SRC.includes('settings.shortcuts.includes(LEGACY_M_SHORTCUT)'), 'a stored copy of the old #m shortcut line is upgraded to the deep-audit description');
ok(SRC.includes("if (msgServedWhole(r.id)) fetchedIds.add(r.id);"), 'only a WHOLE serve marks a message as read for the blind-edit guard');

console.log('== v2.72.0: block SHAPE drift is caught across scenes ==');
// "Compare it with the previous scene's format" — done in code. A field silently
// missing from one scene's block is what breaks a display regex, and it is
// invisible to anyone skimming prose.
dismissPending();
const shaped = (pacing, extra) => ['<details>', '<summary>Plot Momentum</summary>',
    '- NPC Agenda: the queen presses her advantage while the council is still arguing.',
    '- Physics: the small council chamber, rain on the shutters, a guard at every door.',
    (extra ? '- Scene Pacing: ' + pacing : ''), '</details>'].filter(Boolean).join('\n');
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Aftermath', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Slow Burn', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Rising', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('', false) });   // the drifted one
captured = [];
ctx.ConnectionManagerRequestService = capture('noted');
document.getElementById('cc_input').value = '#m structure';
clickFresh('cc_send');
await sleep(700);
const shapeFlags = captured.join('\n');
ok(/field-shape/.test(shapeFlags) && /MISSING: Scene Pacing/.test(shapeFlags), 'a block missing a field the other scenes all carry is flagged by name');
ok(/#3 \[N\]/.test(shapeFlags) && !/#0 \[N\]/.test(shapeFlags), 'only the drifted scene is flagged; the three that agree are the norm');

// Evidence threshold: two agreeing scenes are not yet a norm, so a young chat is
// never nagged about a shape it has not established.
dismissPending();
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Aftermath', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('Slow Burn', true) });
ctx.chat.push({ is_user: false, name: 'N', mes: shaped('', false) });
captured = [];
ctx.ConnectionManagerRequestService = capture('noted');
document.getElementById('cc_input').value = '#m structure';
clickFresh('cc_send');
await sleep(700);
ok(!/field-shape/.test(captured.join('\n')), 'with only two agreeing scenes, shape drift is NOT reported (no norm established yet)');

console.log('== v2.72.0: a stopped audit resumes where it stopped ==');
dismissPending();
ctx.chat.length = 0;
for (let i = 0; i < 20; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Scene ' + i + ' happened.' });
CA.auditWindow = 4;
let contCalls = 0;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 2 of 4')) {
            contCalls++;
            if (contCalls === 2) { const b = document.getElementById('cc_send'); if (b) b.click(); }   // Stop, mid-sweep
            return 'WINDOW CLEAN';
        }
        return 'ok';
    },
};
document.getElementById('cc_input').value = '#m restart';
clickFresh('cc_send');
await sleep(1500);
const cursor = ((ctx.chatMetadata['continuityCopilot'] || {}).audit || {}).cursor;
ok(contCalls < 5, 'Stop actually halted the sweep instead of running every window (' + contCalls + ' windows ran)');
ok(cursor > 0, 'the resume point was persisted to chat metadata (cursor #' + cursor + ')');
ok(/resumes from #/.test(ccLogText().join('\n')), 'the user is told exactly where the next run picks up');
contCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { const all = messages.map(m => String(m.content || '')).join('\n'); if (all.includes('PASS 2 of 4')) { contCalls++; } return 'WINDOW CLEAN'; } };
document.getElementById('cc_input').value = '#m';
clickFresh('cc_send');
await sleep(1500);
ok(contCalls === Math.ceil((20 - cursor) / 4), 'the next run resumed from the saved cursor rather than re-auditing from #0 (' + contCalls + ' windows)');
ok(/Resuming the continuity sweep from #/.test(ccLogText().join('\n')), 'the resume is announced, not silent');

console.log('== v2.72.0: an edit anchored in a SLICE is caught before it fails ==');
// The blind-edit guard used to trust "was fetched". Under a cap, a fetched PART
// is not a read: a "find" copied out of a slice is exactly as blind as one
// invented, so the guard must re-serve the message before the edit is staged.
dismissPending();
CA.recentFull = 0;
CA.fullTextCap = 4000;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'B'.repeat(9000) + 'REAL_TAIL_ONLY_IN_PART_3' });
let blindTurn = 0;
const blindSeen = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        blindSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        blindTurn++;
        if (blindTurn === 1) return '<fetch>["0#1"]</fetch>';
        if (blindTurn === 2) return '<edits>[{"id":0,"find":"BBBB","replace":"CCCC","reason":"guess"}]</edits>';
        return 'ok';
    },
};
document.getElementById('cc_input').value = 'fix the end of it';
clickFresh('cc_send');
await sleep(900);
ok(/Auto-fetched #0/.test(ccLogText().join('\n')), 'an edit proposed off a PART triggers the auto-fetch instead of being staged blind');
CA.fullTextCap = 0;
CA.recentFull = 8;

console.log('== v2.73.0: the memory auditor doctrine runs INSIDE the panel ==');
// Summaryception's MEMORY_AUDITOR.md was a paste-into-another-AI protocol: export
// a transplant .md, audit it elsewhere, re-import the whole file. One wrong number
// cost a full round trip, and the auditor never saw the chat the memory came from.
// Same mandates, live memory, live chat, reviewable cards.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.auditWindow = 6;
ctx.chat.length = 0;
for (let i = 0; i < 6; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Scene ' + i + ' happened at the keep.' });
// One message must actually be broken, or pass 1 has nothing to send and the
// "every pass carries the doctrine" check would silently test only three passes.
ctx.chat.push({ is_user: false, name: 'N', mes: '<details>\n<summary>Tracker</summary>\n- State: fine\n</details>junk welded on' });
ctx.chatMetadata.summary_memory = 'NOTEPAD: Jillian starts at the academy.\nSNIPPET: Jillian rode to the keep. (covers chat messages #0 to #3)';

const seenByPass = {};
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        const m = all.match(/PASS (\d) of 4/);
        if (m) seenByPass[m[1]] = all;
        // Pass 4 only exists when pass 3 states a doubt, so the fixture must state one
        // or the doctrine check would silently cover three passes instead of four.
        if (m && m[1] === '3') return 'Snippet looks thin.\n<verify>[2]</verify>';
        return 'WINDOW CLEAN';
    },
};
document.getElementById('cc_input').value = '#m';
clickFresh('cc_send');
await sleep(1500);
const passes4 = ['1', '2', '3', '4'];
ok(passes4.every(k => seenByPass[k] && seenByPass[k].includes('[AUDITOR DOCTRINE')), 'all four audit passes carry the auditor doctrine');
ok(passes4.every(k => /M-RECORD/.test(seenByPass[k] || '') && /M-EPISTEMIC/.test(seenByPass[k] || '') && /M-SCAN/.test(seenByPass[k] || '') && /M-EYE/.test(seenByPass[k] || '') && /M-TAGS/.test(seenByPass[k] || '')), 'every mandate ships on every pass (record, epistemic, scan, eye, tags)');
ok(/use ONE bulk_replace edit rather than one edit per message/.test(seenByPass['2'] || ''), 'the class sweep is wired to the bulk_replace the extension actually has — not left as advice');
ok(/CORE \(stable identity\), STATE/.test(seenByPass['3'] || ''), 'the ledger field grammar (CORE / STATE / ARC / THREADS) reaches the memory pass');

// The notepad is the OPENING state on purpose. A pass that "reconciles" it against
// later snippets would propose destructive edits to the author's own starting canon.
const mem3 = seenByPass['3'] || '';
ok(/records the OPENING state on purpose/.test(mem3) && /progression, not a contradiction/.test(mem3), 'the memory pass is told the notepad is deliberately static');
ok(!/notepad\/plot-essential vs every snippet/.test(mem3), 'the old instruction to cross-check the notepad against the snippets is gone');

console.log('== v2.73.0: optimize and cleanup, no export/import round trip ==');
dismissPending();
let optSeen = '';
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { optSeen = messages.map(m => String(m.content || '')).join('\n'); return 'Estimated 4100 -> 3600 chars.\n<memedits>[{"find":"Jillian rode to the keep.","replace":"Jillian rode to the keep."}]</memedits>'; } };
const memBefore = ctx.chatMetadata.summary_memory;
document.getElementById('cc_input').value = '#opt';
clickFresh('cc_send');
await sleep(900);
ok(/ZERO-LOSS VERIFICATION/.test(optSeen) && /4-question test/.test(optSeen), '#opt carries the zero-loss contract and the 4-question test');
ok(/SEQUENTIAL AGGREGATION/.test(optSeen) && /NOTATION COMPRESSION last/.test(optSeen), 'the eight techniques ship in order, first and last both present');
ok(/Never touch the notepad. Never reword a pinned quote./.test(optSeen), '#opt is barred from the notepad and from pinned quotes');
ok(ctx.chatMetadata.summary_memory === memBefore, 'nothing was written: the pass only STAGES, Apply is the approval gate');
ok(/nothing has changed yet/.test(ccLogText().join('\n')), 'the verdict says so out loud instead of implying a change happened');

dismissPending();
let clSeen = '';
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { clSeen = messages.map(m => String(m.content || '')).join('\n'); return 'Throughline: a squire becomes a threat.'; } };
document.getElementById('cc_input').value = '#cl';
clickFresh('cc_send');
await sleep(900);
ok(/SPINE/.test(clSeen) && /SUPPORT/.test(clSeen) && /TEXTURE/.test(clSeen) && /NOISE/.test(clSeen), '#cl carries the four-way manifest classification');
ok(/cold-read test/.test(clSeen) && /motivation check/.test(clSeen), '#cl runs the director\u2019s read before any manifest');
ok(/KEEP it and flag it/.test(clSeen) && /attachment is value/.test(clSeen), 'the safeguards survive: unsure keeps, and the author\u2019s attachment wins');

console.log('== v2.73.0: the new commands are documented exactly once ==');
for (const tag of ['#br', '#opt', '#cl']) {
    const hits = (String(CA.shortcuts || '').match(new RegExp('^\\s*' + tag.replace('#', '\\#') + '\\s*=', 'gm')) || []).length;
    ok(hits === 1, tag + ' appears exactly once in the shortcut list (got ' + hits + ')');
}
ok(SRC.includes('for (const line of [BRIEF_SHORTCUT, OPTIMIZE_SHORTCUT, CLEANUP_SHORTCUT])'), 'an install predating these commands gets the lines appended on load');

console.log('== v2.74.0: the sweep reads the VISIBLE chat, not the ghosted history ==');
// A ghosted message is already represented by a memory snippet. Sweeping it again
// audits the same events twice and costs the run its usable length — an hour on a
// long chat. Ghosted originals are pulled only where the memory raises a doubt.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.auditWindow = 4;
CA.auditMaxCalls = 40;
ctx.chat.length = 0;
for (let i = 0; i < 20; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Scene ' + i + ' happened.', is_system: i < 12 });   // 0-11 ghosted, 12-19 visible
ctx.chatMetadata.summary_memory = 'SNIPPET: the early scenes. (covers chat messages #0 to #11)';

const winIds = [];
let verifySeen = '';
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 2 of 4')) {
            const m = all.match(/MESSAGES UNDER AUDIT — #(\d+) to #(\d+)/);
            if (m) winIds.push(m[1] + '-' + m[2]);
            return 'WINDOW CLEAN';
        }
        if (all.includes('PASS 3 of 4')) return 'Snippet is thin around the ambush.\n<verify>["3-5", 9]</verify>';
        if (all.includes('PASS 4 of 4')) { verifySeen = all; return 'DOUBTS RESOLVED'; }
        return 'ok';
    },
};
document.getElementById('cc_input').value = '#m restart';
clickFresh('cc_send');
await sleep(1800);
ok(winIds.length === 2, 'the sweep ran 2 windows for 8 visible messages, not 5 for all 20 (got ' + winIds.length + ': ' + winIds.join(' ') + ')');
ok(winIds.join(' ') === '12-15 16-19', 'every window is built from VISIBLE ids only (got ' + winIds.join(' ') + ')');
ok(/Scope: 8 visible message\(s\) of 20/.test(ccLogText().join('\n')), 'the scope and the cost are stated BEFORE the run, not discovered after an hour');

console.log('== v2.74.0: ghosted originals are pulled only on a stated doubt ==');
ok(/Verifying 4 original message\(s\)/.test(ccLogText().join('\n')), 'pass 4 pulled exactly the ids pass 3 doubted — the "3-5" range expanded plus #9');
ok(/--- #3 \[N\]/.test(verifySeen) && /--- #9 \[N\]/.test(verifySeen) && !/--- #7 \[N\]/.test(verifySeen), 'the doubted originals are served whole; the undoubted ghosted ones are never read');
ok(/ORIGINAL MESSAGES UNDER DOUBT/.test(verifySeen), 'pass 4 is framed as settling doubts against originals, not as a walk of every section');

// A memory that checks out costs ZERO calls in pass 4 — the old shape re-read the
// entire ghosted history to confirm what was already right.
dismissPending();
let pass4Ran = 0;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 4 of 4')) pass4Ran++;
        if (all.includes('PASS 3 of 4')) return 'MEMORY CONSISTENT';
        return 'WINDOW CLEAN';
    },
};
document.getElementById('cc_input').value = '#m restart';
clickFresh('cc_send');
await sleep(1800);
ok(pass4Ran === 0, 'a memory with no doubts costs zero verification calls (got ' + pass4Ran + ')');
ok(/Nothing to verify/.test(ccLogText().join('\n')), 'and it says so rather than silently skipping a pass');

console.log('== v2.74.0: broken blocks inside ghosted messages are reported, not silently repaired ==');
dismissPending();
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: '<details>\n<summary>Tracker</summary>\n- State: fine\n</details>welded junk', is_system: true });
ctx.chat.push({ is_user: false, name: 'N', mes: 'A visible scene, nothing wrong with it.' });
let structCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { if (messages.map(m => String(m.content || '')).join('\n').includes('PASS 1 of 4')) structCalls++; return 'ok'; } };
document.getElementById('cc_input').value = '#m structure';
clickFresh('cc_send');
await sleep(800);
ok(structCalls === 0, 'a ghosted fault spends no model call by default (got ' + structCalls + ')');
ok(/1 of them ghosted — listed, not repaired/.test(ccLogText().join('\n')), 'but it is still reported, with the way to repair it');
dismissPending();
structCalls = 0;
document.getElementById('cc_input').value = '#m structure ghosted';
clickFresh('cc_send');
await sleep(800);
ok(structCalls === 1, '"#m structure ghosted" repairs it on request (got ' + structCalls + ')');

console.log('== v2.74.0: the run has a budget it cannot exceed ==');
dismissPending();
ctx.chat.length = 0;
for (let i = 0; i < 60; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Scene ' + i + '.' });
CA.auditWindow = 2;
CA.auditMaxCalls = 5;
let budgetCalls = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async () => { budgetCalls++; return 'WINDOW CLEAN'; } };
document.getElementById('cc_input').value = '#m restart';
clickFresh('cc_send');
await sleep(2500);
ok(budgetCalls <= 6, 'the budget stopped the run instead of walking all 30 windows (got ' + budgetCalls + ')');
ok(/Call budget reached \(5\)/.test(ccLogText().join('\n')), 'the pause is announced with the number that caused it');
ok(((ctx.chatMetadata['continuityCopilot'] || {}).audit || {}).cursor > 0, 'the resume point survives a budget pause, so #m continues rather than restarts');
CA.auditMaxCalls = 40;
CA.auditWindow = 6;

console.log('== v2.75.0: the memory is read as ONE ordered story ==');
// A memory too large for one call used to be audited section by section with no
// view of the other sections — so a fact established in snippet 5 and contradicted
// in snippet 60 was invisible to every pass that ran.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.auditWindow = 6;
CA.auditMaxCalls = 40;
ctx.chat.length = 0;
for (let i = 0; i < 4; i++) ctx.chat.push({ is_user: false, name: 'N', mes: 'Visible scene ' + i + '.' });

// A memory big enough to need several sections, with entries in story order.
const entry = (n, from, to) => 'Jillian did the thing numbered ' + n + ' and the consequences ran on for a while afterwards. (covers chat messages #' + from + ' to #' + to + ')';
const many = [];
for (let n = 1; n <= 120; n++) many.push(entry(n, (n - 1) * 3, n * 3 - 1));
ctx.chatMetadata.summary_memory = '--- opening ---\n' + many.join('\n');

const memCalls = [];
let crossSeen = '';
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        const all = messages.map(m => String(m.content || '')).join('\n');
        if (all.includes('PASS 3 of 4')) { memCalls.push(all); return 'Entry [7] contradicts entry [98].'; }
        if (all.includes('PASS 3b')) { crossSeen = all; return 'SECTIONS AGREE'; }
        return 'WINDOW CLEAN';
    },
};
document.getElementById('cc_input').value = '#m restart';
clickFresh('cc_send');
await sleep(2200);
ok(memCalls.length > 1, 'the memory was large enough to need several sections (' + memCalls.length + ')');
ok(memCalls.every(c => /\[MEMORY SPINE — every entry in story order/.test(c)), 'EVERY section call carries the spine block — the index of all the entries it is not holding');   // the prompt text alone mentions [MEMORY SPINE], so match the injected block header
ok(memCalls.every(c => /\[1\] \(#0–#2\)/.test(c) && /\[120\] \(#357–#359\)/.test(c)), 'the spine runs from the first entry to the last, in story order, with coverage ranges');
ok(/as ONE story/i.test(memCalls[0]) && /chronological order, not a list of independent entries/.test(memCalls[0]), 'the pass is told the memory is one narrative, not a bag of entries');
ok(/inherits its state/.test(memCalls[0]), 'and that later entries inherit what earlier ones established');
ok(/FINDINGS SO FAR/.test(memCalls[memCalls.length - 1]), 'what an earlier section found is carried into the later ones');
ok(crossSeen && /faults that span sections/.test(crossSeen), 'a cross-section pass runs specifically for contradictions BETWEEN distant entries');
ok(/Entry \[7\] contradicts entry \[98\]/.test(crossSeen), 'the section findings are handed to it so it can join them up');

console.log('== v2.75.0: an entry is never cut in half ==');
// The old chunker hard-sliced at a character count once a section grew large —
// the silent-truncation bug of v2.72, hiding in the memory path.
const longLine = 'X'.repeat(30000) + ' END_OF_ENTRY_MARKER';
ctx.chatMetadata.summary_memory = '--- big ---\n' + longLine + '\n' + entry(1, 0, 3);
const chunkCalls = [];
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { const all = messages.map(m => String(m.content || '')).join('\n'); if (all.includes('PASS 3 of 4')) chunkCalls.push(all); return 'MEMORY CONSISTENT'; } };
dismissPending();
document.getElementById('cc_input').value = '#m restart';
clickFresh('cc_send');
await sleep(2200);
ok(chunkCalls.some(c => c.includes('X'.repeat(30000) + ' END_OF_ENTRY_MARKER')), 'an over-budget entry is delivered WHOLE rather than sliced at a character count');

console.log('== v2.75.0: ordering faults are proven in code, not guessed ==');
dismissPending();
const bad = [
    entry(1, 0, 5),
    entry(2, 6, 11),
    entry(3, 9, 14),      // overlaps #2
    entry(4, 3, 8),       // jumps backwards
    entry(5, 40, 45),     // leaves a gap
    'Jillian rode out again on a long road with nothing much happening. (covers chat messages #60 to #50)',   // backwards
];
ctx.chatMetadata.summary_memory = '--- ordering ---\n' + bad.join('\n');
let orderSeen = '';
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { const all = messages.map(m => String(m.content || '')).join('\n'); if (all.includes('PASS 3 of 4')) orderSeen = all; return 'MEMORY CONSISTENT'; } };
document.getElementById('cc_input').value = '#m restart';
clickFresh('cc_send');
await sleep(1800);
ok(/range-overlap/.test(orderSeen), 'overlapping coverage is flagged (the same events recorded twice)');
ok(/out-of-order/.test(orderSeen), 'an entry covering earlier messages than the one before it is flagged');
ok(/coverage-gap/.test(orderSeen), 'a span nothing covers is flagged');
ok(/range-backwards/.test(orderSeen), 'a range that runs backwards is flagged');
ok(/proven by a code scan of the coverage ranges/.test(orderSeen), 'they reach the model as facts, not as something to re-derive');
const orderLog = ccLogText().join('\n');
ok(/Memory order: \d+ provable ordering fault/.test(orderLog), 'and the user is told before any model call');

console.log('== v2.75.0: a healthy memory says so, and one section needs no cross pass ==');
dismissPending();
ctx.chatMetadata.summary_memory = '--- clean ---\n' + [entry(1, 0, 3), entry(2, 4, 7), entry(3, 8, 11)].join('\n');
let crossRan = 0;
ctx.ConnectionManagerRequestService = { sendRequest: async (pid, messages) => { const all = messages.map(m => String(m.content || '')).join('\n'); if (all.includes('PASS 3b')) crossRan++; return all.includes('PASS 3 of 4') ? 'MEMORY CONSISTENT' : 'WINDOW CLEAN'; } };
document.getElementById('cc_input').value = '#m restart';
clickFresh('cc_send');
await sleep(1800);
ok(crossRan === 0, 'a memory that fits in ONE section needs no cross-section pass and is not charged for one');
ok(/coverage runs forward, no overlaps or duplicates/.test(ccLogText().join('\n')), 'a clean ordering is reported as a positive result, not silence');

console.log('== v2.76.0: an anchor that cannot match never becomes a card ==');
// A "find" that does not exist used to sail through staging and fail at Apply —
// so the user had to notice the failure and ask for a re-proposal. The check now
// runs the SAME resolver the apply uses, while the real text is still in context.
dismissPending();
CA.profileId = 'gate-profile';
CA.streaming = false;
CA.recentFull = 8;
CA.fetchRounds = 3;
ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'The queen crossed the yard at dusk and said nothing to the guard.' });
ctx.chatMetadata.summary_memory = 'The queen crossed the yard at dusk. (covers chat messages #0 to #0)';

let aTurn = 0;
const seen = [];
const proposalNotesBefore = (ccLogText().join('\n').match(/proposed edits below/g) || []).length;
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        seen.push(messages.map(m => String(m.content || '')).join('\n'));
        aTurn++;
        if (aTurn === 1) return 'Fixing it.\n<edits>[{"id":0,"find":"the queen walked across the courtyard at sunset","replace":"X","reason":"paraphrased anchor"}]</edits>';
        return 'Corrected.\n<edits>[{"id":0,"find":"crossed the yard at dusk","replace":"crossed the yard at dawn","reason":"fixed"}]</edits>';
    },
};
document.getElementById('cc_input').value = 'fix the time of day';
clickFresh('cc_send');
await sleep(900);
// The log carries both textContent and innerHTML, so quotes appear HTML-escaped:
// match the stable prose, not the punctuation around it.
const anchorNotes = () => (ccLogText().join('\n').match(/Anchor check: \d+ proposal/g) || []).length;
const anchorLog = ccLogText().join('\n');
ok(/Anchor check: 1 proposal\(s\) had a/.test(anchorLog) && /that does not exist in the target/.test(anchorLog), 'the impossible anchor is caught BEFORE staging, not at Apply');
ok(seen.length >= 2 && /ANCHOR CHECK — these proposals cannot apply as written/.test(seen[1]), 'the model is handed the failure and asked to correct it in the same run');
ok(/that exact text does not occur in message #0/.test(seen[1]), 'it is told exactly which target the anchor missed');
ok(/NEVER build a "find" from a \[MESSAGE INDEX\] preview line or a \[MEMORY SPINE\] line/.test(seen[1]), 'and told where anchors must never come from');
ok((ccLogText().join('\n').match(/proposed edits below/g) || []).length === proposalNotesBefore + 1, 'only ONE reply was ingested — the dead first proposal was corrected, not staged and then patched');

// A GOOD anchor must not trigger the check — a false alarm would cost a round on
// every reply. The resolver is the apply's own, fuzzy floor included.
dismissPending();
const anchorsBefore = anchorNotes();
aTurn = 0;
let goodRounds = 0;
ctx.ConnectionManagerRequestService = {
    // A DIFFERENT edit from the one just dismissed: an identical re-proposal of a
    // dismissed card is correctly suppressed, which would prove nothing here.
    sendRequest: async () => { goodRounds++; return '<edits>[{"id":0,"find":"said nothing to the guard","replace":"said nothing to the sentry","reason":"ok"}]</edits>'; },
};
document.getElementById('cc_input').value = 'fix it again';
clickFresh('cc_send');
await sleep(700);
ok(goodRounds === 1, 'a valid anchor costs no extra round (got ' + goodRounds + ')');
// goodRounds === 1 above is the real proof no correction round fired; what matters
// next is that the valid proposal actually reached the user as a card.
void anchorsBefore; void anchorNotes;
ok(/proposed edits below/.test(ccLogText().slice(-2).join(' ')), 'and the valid proposal is ingested normally rather than sent back for correction');

console.log('== v2.76.0: a memory anchor is checked against the live memory ==');
dismissPending();
aTurn = 0;
const memSeen = [];
ctx.ConnectionManagerRequestService = {
    sendRequest: async (pid, messages) => {
        memSeen.push(messages.map(m => String(m.content || '')).join('\n'));
        aTurn++;
        if (aTurn === 1) return '<memedits>[{"find":"The monarch traversed the courtyard","replace":"Y","reason":"invented"}]</memedits>';
        return 'MEMORY CONSISTENT';
    },
};
document.getElementById('cc_input').value = 'fix the memory line';
clickFresh('cc_send');
await sleep(900);
ok(memSeen.length >= 2 && /that exact text does not occur anywhere in the memory/.test(memSeen[1]), 'an invented memory anchor is caught against the live memory');

console.log('== v2.76.0: a dead card does not outlive its replacement ==');
// supersededByNew() retired an older PENDING card only on anchor EQUALITY. A
// corrected re-proposal carries a DIFFERENT anchor by definition — that is the
// point of correcting it — so the wrong card could never be retired and the user
// dismissed it by hand every time. Cards are not in the DOM in this harness, so
// the observable is the ingest note.
dismissPending();
const skipNotes = () => (ccLogText().join('\n').match(/auto-skipped/gi) || []).length;

ctx.chat.length = 0;
ctx.chat.push({ is_user: false, name: 'N', mes: 'A scene that is not being edited here.' });
ctx.chatMetadata.summary_memory = 'ALPHA line: the queen crossed the yard at dusk.\nGAMMA line: the steward counted the ravens.';
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<memedits>[{"find":"ALPHA line: the queen crossed the yard at dusk.","replace":"ALPHA line: the queen crossed the yard at dawn.","reason":"first try"}]</memedits>' };
document.getElementById('cc_input').value = 'fix the alpha line';
clickFresh('cc_send');
await sleep(700);
const skipsBefore = skipNotes();

// The memory drifts underneath the staged card: its anchor is now unfindable.
ctx.chatMetadata.summary_memory = 'BETA line: the queen crossed the courtyard at dusk.\nGAMMA line: the steward counted the ravens.';
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<memedits>[{"find":"BETA line: the queen crossed the courtyard at dusk.","replace":"BETA line: the queen crossed the courtyard at dawn.","reason":"corrected anchor"}]</memedits>' };
document.getElementById('cc_input').value = 'try again against the current memory';
clickFresh('cc_send');
await sleep(900);
ok(skipNotes() > skipsBefore, 'a corrected proposal retires the dead card automatically — no hand dismissal (' + skipsBefore + ' -> ' + skipNotes() + ')');
ok(/anchor no longer matches/i.test(ccLogText().join('\n')) || /older duplicate\(s\) auto-skipped/i.test(ccLogText().join('\n')), 'and the reason is stated rather than the card just vanishing');

// The other half of the rule: a still-VALID pending fix must survive a new,
// unrelated proposal. Retiring those would silently drop work the user wanted.
dismissPending();
ctx.chatMetadata.summary_memory = 'ALPHA line: the queen crossed the yard at dusk.\nGAMMA line: the steward counted the ravens.';
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<memedits>[{"find":"ALPHA line: the queen crossed the yard at dusk.","replace":"ALPHA line: the queen crossed the yard at dawn.","reason":"still valid"}]</memedits>' };
document.getElementById('cc_input').value = 'fix alpha';
clickFresh('cc_send');
await sleep(700);
const skipsBefore2 = skipNotes();
ctx.ConnectionManagerRequestService = { sendRequest: async () => '<memedits>[{"find":"GAMMA line: the steward counted the ravens.","replace":"GAMMA line: the steward counted the ravens twice.","reason":"different line"}]</memedits>' };
document.getElementById('cc_input').value = 'now fix gamma too';
clickFresh('cc_send');
await sleep(900);
ok(skipNotes() === skipsBefore2, 'a pending fix whose anchor is still good is NOT retired by an unrelated new proposal (' + skipsBefore2 + ' -> ' + skipNotes() + ')');

console.log('');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) { console.log('MODULE INTEGRITY FAILED ✗'); process.exit(1); }
console.log('MODULE INTEGRITY OK ✓');
