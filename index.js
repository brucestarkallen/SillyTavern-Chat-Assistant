/**
 * Summaryception v5.5.3 — Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * AGPL-3.0
 */

// ─── Imports ─────────────────────────────────────────────────────────
import {
    sendSummarizerRequest,
    fetchOllamaModels,
    testOpenAIConnection,
    populateProfileDropdown,
    getConnectionDisplayName,
} from './connectionutil.js';

const MODULE_NAME = 'summaryception';
const LOG_PREFIX = '[Summaryception]';
// const TRACE_MODE = true;  // ultra-verbose logging

// ─── Default Settings ────────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    verbatimTurns: 10,
    turnsPerSummary: 3,
    snippetsPerLayer: 30,
    snippetsPerPromotion: 3,
    maxLayers: 5,
    injectionTemplate: '\n\n<summary>\n{{summary}}\n</summary>\n\n',

    // ── Injection placement (previously hardcoded to IN_PROMPT / system) ──
    injectionPosition: 1,   // 0 = in-prompt (merged w/ system) · 1 = in-chat @ depth · 2 = before-prompt
    injectionDepth: 4,      // messages up from newest; only used when position = 1
    injectionRole: 0,       // 0 = system · 1 = user · 2 = assistant

    // ── Manual notepad wrapper (the note text itself is stored per-chat, in chat metadata) ──
    notepadTemplate: '\n\n<notes>\n{{notes}}\n</notes>\n',

    // ── Detail Auditor ("sister"): a SECOND pass, per batch, that checks whether the
    //    compact snippet dropped important specifics the storyteller would need, and if
    //    so records ONLY the omissions as a short director's-note attached to that
    //    snippet. Empty (NONE) for routine batches. Never touches the snippet itself. ──
    sisterEnabled: true,
    sisterInjectTemplate: '\n\n<details>\nSpecifics behind recent events (canon — do not contradict):\n{{details}}\n</details>\n',
    sisterSystemPrompt:
        'Role: continuity auditor for an ongoing fiction. You receive a compact summary snippet and the exact passage it was made from. Your ONLY job: decide whether the snippet dropped important, hard-to-reconstruct specifics a future storyteller would need — exact numbers, named plans or tactics, specific commitments or conditions, precise capabilities, or identity details. If the snippet already captures everything important, output exactly: NONE. Otherwise output a single "DETAIL:" line containing ONLY the missing specifics, as terse director\'s notes (breaking the fourth wall is fine). Never repeat anything the snippet or prior context already contains. No preamble, no markdown, no commentary.',
    sisterUserPrompt:
        `<player_name>{{player_name}}</player_name>\n<prior_context>{{context_str}}</prior_context>\n<passage>{{story_txt}}</passage>\n<snippet>{{snippet}}</snippet>\n\n<snippet> is the compact memory line already recorded for <passage>.\n\nDecide: does <snippet> omit any important specifics from <passage> that a storyteller would need and could NOT reconstruct from the gist alone? Consider: exact quantities/counts, named tactics or plans, specific conditional promises ("if X then Y"), precise capabilities or limits, and identity/title details.\n\nRecord ONLY omissions that are ALL of: (a) present in <passage>, (b) NOT already in <snippet>, (c) NOT already in <prior_context>.\n\nIf <snippet> already captures everything important, output exactly:\nNONE\n\nOtherwise output ONE line:\nDETAIL: <only the missing specifics, short phrases separated by semicolons>`,

    // ── Continuity Editor ("Co-Writer / Master Novelist") prompts ──
    editorSystemPrompt:
        'Role: master continuity editor and co-writer for an ongoing roleplay. You receive the story\'s full memory — a notepad of established canon (plot-essential lore), an ordered list of summary snippets, and their detail notes — plus an instruction describing a problem or retcon. Determine the MINIMAL set of edits that resolves the problem and keeps everything internally consistent. Change only what must change; preserve each entry\'s terse style. Output STRICT JSON ONLY: a single array of edit operations — no prose, no markdown, no commentary. If nothing needs changing, output [].',
    editorUserPrompt:
        `<player_name>{{player_name}}</player_name>\n\n<instruction>\n{{command}}\n</instruction>\n\n<memory>\n{{memory}}\n</memory>\n\n<memory> has "notepad" (established canon) and "snippets" (each with an "id" like "L0#3", its "text", and optional "detail"). Apply <instruction> by editing memory so the whole story stays logical and consistent.\n\nReturn a JSON array of edit operations. Allowed ops:\n{"op":"edit_notepad","text":"<full new notepad>","reason":"<short why>"}\n{"op":"edit_snippet","id":"L0#3","text":"<new snippet text>","reason":"<short why>"}\n{"op":"delete_snippet","id":"L0#3","reason":"<short why>"}\n{"op":"edit_detail","id":"L0#3","text":"<new detail text>","reason":"<short why>"}\n{"op":"delete_detail","id":"L0#3","reason":"<short why>"}\n\nRules: reference snippets ONLY by their exact "id" from <memory>. Keep edits minimal — do not rewrite unaffected entries. Output ONLY the JSON array (or [] if nothing needs changing).`,

    summarizerSystemPrompt:
        'Role: precise narrative-state tracker. Output only the summary line — no preamble, no commentary, no markdown.',

    summarizerUserPrompt:
        `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the summary output instead of 'you'.

Focus on: character interactions, dialogue tone, and relationship dynamics; emotional beats and character motivations; atmosphere, mood, and sensory details that establish tone; narrative themes and subtext; names, location changes, and time; plot developments and unresolved tensions; details that distinguish this moment from any other.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.

Write in short phrases, no more than 20; output must be a single line:`,

    promptPreset: 'narrative',  // 'narrative' | 'gamestate' | 'custom'
    savedCustomPrompts: {},        // { name: promptText } — named custom prompt slots
    lastCustomPrompt: '',          // Auto-saved when switching away from custom
    pauseSummarization: false,  // true = stop processing, keep injecting
    disableGhosting: false,  // true = mark as summarized but don't hide messages

    stripPatterns: [
        '<|channel>thought',
        '<channel|>',
        '<output>',
        '</output>',
        '<thinking>',
        '</thinking>',
    ],

    debugMode: false,
    traceMode: false,

    // ─── Connection Settings ─────────────────────────────────────
    connectionSource: 'default',          // 'default' | 'profile' | 'ollama' | 'openai'
    summarizerResponseLength: 0,          // 0 = use preset default; set lower if you get "max_tokens > 4096 must have stream=true" errors
    connectionProfileId: '',              // ID of selected ST Connection Profile
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: '',
    ollamaModelsCache: [],                // Cached model list from Ollama
    openaiUrl: '',
    openaiKey: '',
    openaiModel: '',
    openaiMaxTokens: 0,                   // 0 = no limit (provider default)
});

// ─── Prompt Presets ──────────────────────────────────────────────────

const PROMPT_PRESETS = {
    narrative: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context. If the passage_in_question has 2nd person point of view, 'you' pronoun in prose refers to the player. Use the player name in the summary output instead of 'you'.

Focus on: character interactions, dialogue tone, and relationship dynamics; emotional beats and character motivations; atmosphere, mood, and sensory details that establish tone; narrative themes and subtext; names, location changes, and time; plot developments and unresolved tensions; details that distinguish this moment from any other.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.

Write in short phrases, no more than 20; output must be a single line:`,

    gamestate: `<player_name>
{{player_name}}
</player_name>

<prior_context>
{{context_str}}
</prior_context>

<passage_in_question>
{{story_txt}}
</passage_in_question>

Summarize only the necessary elements from the passage_in_question to coherently continue the prior_context.

Focus on: story progression, plot points, plans, tasks, quests; location changes and current location (reference by name); location interactables encountered, used, or discovered; significant changes to player, NPCs, locations, world, or setting.

Exclude anything insubstantial, fluff, atmospheric details, or events already covered in Prior Context.
Skip any passages that are empty, unclear, or lack significant content.
Write in short phrases, no more than 20; output must be a single line:`,

    custom: null, // Uses whatever is in the textarea
};

const DEFAULT_PROMPT_PRESET = 'narrative';

// ─── Retry Configuration ─────────────────────────────────────────────

const RETRY_CONFIG = {
    maxRetries: 5,
    baseDelay: 2000,
    maxDelay: 60000,
    backoffMultiplier: 2,
    retryableStatuses: [429, 500, 502, 503, 504],
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(error) {
    try {
        const retryAfter = error?.response?.headers?.['retry-after']
            || error?.retryAfter
            || error?.data?.retry_after;
        if (!retryAfter) return null;
        const seconds = Number(retryAfter);
        if (!isNaN(seconds)) return seconds * 1000;
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
            return Math.max(0, date.getTime() - Date.now());
        }
    } catch (e) { /* ignore */ }
    return null;
}

function isRetryableError(error) {
    if (error?.name === 'AbortError') return false;

    // ConnectionError from connectionutil.js carries an explicit retryable flag.
    if (error?.name === 'ConnectionError' && typeof error.retryable === 'boolean') {
        return error.retryable;
    }

    if (error?.name === 'TypeError' && error?.message?.includes('fetch')) return true;
    const status = error?.status || error?.response?.status || error?.statusCode;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) return true;
    const msg = (error?.message || error?.toString() || '').toLowerCase();
    if (msg.includes('rate limit')) return true;
    if (msg.includes('too many requests')) return true;
    if (msg.includes('server error')) return true;
    if (msg.includes('timeout')) return true;
    if (msg.includes('econnreset')) return true;
    if (msg.includes('econnrefused')) return true;
    if (msg.includes('network')) return true;
    if (msg.includes('overloaded')) return true;
    if (msg.includes('capacity')) return true;
    return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function log(...args) {
    if (getSettings().debugMode) console.log(LOG_PREFIX, ...args);
}

function trace(...args) {
    const s = getSettings();
    if (s.debugMode && s.traceMode) {
        const normalized = args.map((arg, idx) => (idx === 0 && typeof arg === 'string')
            ? arg.toUpperCase()
            : arg);
        console.log(LOG_PREFIX, '[TRACE]', ...normalized);
    }
}

function debugVisibleTurns(chat, store) {
    trace('=== DEBUG VISIBLE TURNS ===');
    trace('  store.summarizedUpTo:', store.summarizedUpTo);
    trace('  Total chat messages:', chat.length);

    let visibleCount = 0;
    let ghostedCount = 0;
    let hiddenCount = 0;
    let visibleIndices = [];

    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes?.trim()?.length > 0) {
            visibleCount++;
            visibleIndices.push(i);
        }
        if (m.extra?.sc_ghosted) ghostedCount++;
        if (m.is_hidden || m.is_system) hiddenCount++;
    }

    trace('  Visible non-ghosted turns:', visibleCount);
    trace('  Ghosted turns:', ghostedCount);
    trace('  Hidden/System turns:', hiddenCount);
    trace('  First 10 visible indices:', visibleIndices.slice(0, 10));
    trace('  Last 10 visible indices:', visibleIndices.slice(-10));

    // Check for messages that should have been ghosted but aren't
    const unghosteredSummarized = visibleIndices.filter(idx => idx <= store.summarizedUpTo);
    if (unghosteredSummarized.length > 0) {
        trace('  ⚠️ WARNING: Found ' + unghosteredSummarized.length + ' visible messages that are BEFORE summarizedUpTo!');
        trace('  First 5 unghostered summarized indices:', unghosteredSummarized.slice(0, 5));
    }
    trace('=== END DEBUG ===');
}

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

function getChatStore() {
    const { chatMetadata } = SillyTavern.getContext();
    if (!chatMetadata[MODULE_NAME]) {
        chatMetadata[MODULE_NAME] = {
            layers: [],
            summarizedUpTo: -1,
            ghostedIndices: [],           // Track which messages WE ghosted
        };
    }
    // Migration: add ghostedIndices if missing from older saves
    if (!chatMetadata[MODULE_NAME].ghostedIndices) {
        chatMetadata[MODULE_NAME].ghostedIndices = [];
    }
    // Manual notepad — per-chat story/lore memory you write yourself
    if (chatMetadata[MODULE_NAME].notepad === undefined) {
        chatMetadata[MODULE_NAME].notepad = '';
    }
    return chatMetadata[MODULE_NAME];
}

async function saveChatStore() {
    await SillyTavern.getContext().saveMetadata();
}

function getPlayerName() {
    const ctx = SillyTavern.getContext();
    return ctx.name1 || 'User';
}

// ─── Message Hiding (Ghosting via native /hide /unhide) ──────────────
async function repairGhostingForRange(startIdx, endIdx) {
    trace('>>> ENTERING repairGhostingForRange');
    trace(' startIdx:', startIdx, 'endIdx:', endIdx);

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();
    let repaired = 0;
    let skipped = 0;

    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;

        if (m.extra?.sc_ghosted) {
            skipped++;
            continue;
        }

        if (m.is_hidden && !m.extra?.sc_ghosted) {
            trace(' Skipping message ' + i + ' - user-hidden');
            skipped++;
            continue;
        }

        if (m.is_system || !m.mes?.trim()) {
            skipped++;
            continue;
        }

        if (m.is_user) {
            skipped++;
            continue;
        }

        trace(' Ghosting message ' + i);
        m.extra = m.extra || {};
        m.extra.sc_ghosted = true;

        if (!store.ghostedIndices.includes(i)) {
            store.ghostedIndices.push(i);
        }

        // Only visually hide if ghosting is enabled
        if (!s.disableGhosting) {
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`, { showOutput: false });
                repaired++;
            } catch (e) {
                console.error(LOG_PREFIX, 'Failed to ghost message ' + i + ':', e);
            }
        } else {
            repaired++;
        }
    }

    trace(' Repaired:', repaired, 'Skipped:', skipped);
    await saveChatStore();
    trace('<<< EXITING repairGhostingForRange');
    return repaired;
}

async function ghostMessage(messageIndex) {
    const { chat } = SillyTavern.getContext();
    const msg = chat[messageIndex];
    if (!msg) return;
    if (!msg.extra) msg.extra = {};
    if (msg.extra.sc_ghosted) return;

    msg.extra.sc_ghosted = true;

    // Track that WE ghosted this message
    const store = getChatStore();
    if (!store.ghostedIndices.includes(messageIndex)) {
        store.ghostedIndices.push(messageIndex);
    }

    // Only visually hide if ghosting is enabled
    const s = getSettings();
    if (!s.disableGhosting) {
        try {
            await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${messageIndex}`, { showOutput: false });
        } catch (e) {
            log(`Failed to hide message ${messageIndex}:`, e);
        }
    }

    log(`Ghosted message at index ${messageIndex}${s.disableGhosting ? ' (hiding disabled)' : ''}`);
}

async function unghostAllMessages() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // Only unhide messages that WE ghosted, not user-hidden messages
    const toUnhide = store.ghostedIndices && store.ghostedIndices.length > 0
        ? [...store.ghostedIndices]
        : [];

    // Fallback for older saves that don't have ghostedIndices:
    // find messages with our sc_ghosted flag
    if (toUnhide.length === 0) {
        for (let i = 0; i < chat.length; i++) {
            if (chat[i]?.extra?.sc_ghosted) {
                toUnhide.push(i);
            }
        }
    }

    if (toUnhide.length === 0) return;

    const progressToast = toastr.info(
        `Unhiding messages: 0 / ${toUnhide.length}`,
        'Summaryception — Clearing',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
        }
    );

    let processed = 0;
    for (const idx of toUnhide) {
        if (idx >= 0 && idx < chat.length) {
            // Clear our ghost flag
            if (chat[idx]?.extra?.sc_ghosted) {
                delete chat[idx].extra.sc_ghosted;
            }

            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${idx}`, { showOutput: false });
            } catch (e) {
                log(`Failed to unhide message ${idx}:`, e);
            }
        }

        processed++;
        if (processed % 10 === 0) {
            const pct = Math.round((processed / toUnhide.length) * 100);
            $(progressToast).find('.toast-message').text(
                `Unhiding messages: ${processed} / ${toUnhide.length} (${pct}%)`
            );
        }
    }

    // Clear the tracking array
    store.ghostedIndices = [];

    toastr.clear(progressToast);
    log(`Unghosted ${toUnhide.length} messages (only Summaryception-hidden ones)`);
}

async function ghostMessagesUpTo(endIndex) {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();
    const s = getSettings();

    const progressToast = !s.disableGhosting ? toastr.info(
        `Hiding messages: 0 / ${endIndex + 1}`,
        'Summaryception — Ghosting',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
        }
    ) : null;

    let processed = 0;
    for (let i = 0; i <= endIndex; i++) {
        const msg = chat[i];
        if (!msg) continue;
        if (msg.is_system && !msg.extra?.sc_ghosted) continue;
        if (!msg.extra) msg.extra = {};
        if (msg.extra.sc_ghosted) continue;

        // Check if the message is already hidden by the user (not by us)
        if (msg.is_hidden) {
            log(`Skipping message ${i} — already hidden by user`);
            continue;
        }

        msg.extra.sc_ghosted = true;

        // Track that WE ghosted this message
        if (!store.ghostedIndices.includes(i)) {
            store.ghostedIndices.push(i);
        }

        // Only visually hide if ghosting is enabled
        if (!s.disableGhosting) {
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/hide ${i}`, { showOutput: false });
            } catch (e) {
                log(`Failed to hide message ${i}:`, e);
            }
        }

        processed++;
        if (!s.disableGhosting && progressToast && processed % 10 === 0) {
            const pct = Math.round((i / (endIndex + 1)) * 100);
            $(progressToast).find('.toast-message').text(
                `Hiding messages: ${i} / ${endIndex + 1} (${pct}%)`
            );
        }
    }

    if (progressToast) toastr.clear(progressToast);
    log(`Ghosted messages from index 0 to ${endIndex}${s.disableGhosting ? ' (hiding disabled — metadata only)' : ''}`);
}

// ─── Branch Detection & Repair ───────────────────────────────────────

/**
 * Detect if the current chat was branched before the summarized point.
 * When ST creates a branch at message N, it copies messages 0..N into a new chat file.
 * But chatMetadata (including our store) is copied as-is, so summarizedUpTo might
 * point beyond the end of the new chat, and snippets may reference turns that
 * no longer exist in this branch.
 *
 * This function detects that condition and trims our store to match reality.
 */
async function repairIfBranched() {
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    if (!chat || chat.length === 0) return;

    const chatLength = chat.length;
    const s = getSettings();
    const layer0 = store.layers && store.layers[0] ? store.layers[0] : null;

    // ── Work out the verbatim window FIRST (the trigger below depends on it):
    //    the most recent `verbatimTurns` assistant turns that still exist in this
    //    branch should be verbatim (visible, word-for-word). Ghosted assistant
    //    turns are is_system=true, so include those in the count. ──
    const asstTurns = [];
    for (let i = 0; i < chatLength; i++) {
        const m = chat[i];
        if (!m || !m.mes || !m.mes.trim()) continue;
        const isOurGhost = m.extra?.sc_ghosted === true;
        if (!m.is_user && (!m.is_system || isOurGhost)) asstTurns.push(i);
    }
    const keep = Math.max(0, asstTurns.length - (s.verbatimTurns ?? 10));
    const verbatimStartIdx = asstTurns.length > 0
        ? (keep < asstTurns.length ? asstTurns[keep] : chatLength)
        : chatLength;

    // Repair is needed when ANY of these hold:
    //   • summaryOverruns — the summary pointer sits at/past the (new, shorter) chat end.
    //   • snippetOverruns — a snippet references turns beyond the chat end.
    //   • verbatimGhosted — the summary has eaten INTO the verbatim window, i.e. the
    //       branch left FEWER than `verbatimTurns` turns actually visible. This is the
    //       branch-at-N case: e.g. turns 55-60 are summarized, you branch at 61, and
    //       those recent turns stay ghosted with only the summary as anchor. Without
    //       this check they never return to verbatim and continuity breaks (the MC's
    //       recent actions exist only as summary, not as on-screen prose).
    const summaryOverruns = store.summarizedUpTo >= chatLength;
    const snippetOverruns = !!layer0 && layer0.some(sn => sn.turnRange && sn.turnRange[1] >= chatLength);
    const verbatimGhosted = store.summarizedUpTo >= verbatimStartIdx;
    if (!summaryOverruns && !snippetOverruns && !verbatimGhosted) return;   // healthy — leave it alone

    const oldSummarizedUpTo = store.summarizedUpTo;
    log(`Repair triggered (overrun=${summaryOverruns || snippetOverruns}, verbatimGhosted=${verbatimGhosted}). summarizedUpTo=${oldSummarizedUpTo}, chatLength=${chatLength}, verbatimStartIdx=${verbatimStartIdx}. Repairing...`);

    // ── 2. Drop Layer 0 snippets that cover turns in the verbatim window or
    //       beyond the branch point. (verbatimStartIdx <= chatLength, so this
    //       also removes any snippet that runs past the end of the branch.) ──
    if (layer0) {
        const before = layer0.length;
        store.layers[0] = layer0.filter(sn => {
            if (!sn.turnRange) return true;                 // promoted seeds w/o range: keep
            return sn.turnRange[1] < verbatimStartIdx;
        });
        const removed = before - store.layers[0].length;
        if (removed > 0) log(`Removed ${removed} Layer 0 snippet(s) covering the verbatim window / beyond the branch.`);
    }

    // ── 3. Recompute summarizedUpTo from the snippets that survived. ──
    const survivors = (store.layers[0] || []).filter(sn => sn.turnRange);
    store.summarizedUpTo = survivors.length > 0
        ? Math.max(...survivors.map(sn => sn.turnRange[1]))
        : -1;

    // ── 4. Un-ghost everything past the (new) summarized boundary, so no turn is
    //       ever both hidden AND unsummarized. This restores the verbatim window
    //       and rescues any turns orphaned by a straddling snippet. ──
    let unghosted = 0;
    for (let i = store.summarizedUpTo + 1; i < chatLength; i++) {
        const m = chat[i];
        if (m?.extra?.sc_ghosted) {
            delete m.extra.sc_ghosted;
            try {
                await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${i}`, { showOutput: false });
            } catch (e) {
                log(`Failed to unhide message ${i}:`, e);
            }
            unghosted++;
        }
    }

    // ── 5. Trim the ghost tracking to only valid, still-summarized indices. ──
    store.ghostedIndices = (store.ghostedIndices || [])
        .filter(idx => idx < chatLength && idx <= store.summarizedUpTo);

    await saveChatStore();

    log(`Branch repair complete. summarizedUpTo: ${oldSummarizedUpTo} → ${store.summarizedUpTo}, un-ghosted ${unghosted} turn(s).`);
    toastr.info(
        `Branch repaired — rewound the summary to turn ${store.summarizedUpTo} and restored ${unghosted} recent turn(s) to verbatim. They'll be re-summarized as this branch grows.`,
        'Summaryception — Branch Repair',
        { timeOut: 6000 }
    );
}

// ─── Assistant Turn Utilities ────────────────────────────────────────

function getAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        const isOurGhost = m.extra?.sc_ghosted === true;
        const isAssistant = !m.is_user && (!m.is_system || isOurGhost);
        if (isAssistant && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

function getVisibleAssistantTurns(chat) {
    const turns = [];
    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m.is_user && !m.is_system && !m.extra?.sc_ghosted && m.mes && m.mes.trim().length > 0) {
            turns.push({ index: i, mes: m.mes, name: m.name || 'Assistant' });
        }
    }
    return turns;
}

/**
 * Build passage text from a range of chat messages.
 * Skips messages that are hidden (by user or system) UNLESS they were
 * hidden by Summaryception (sc_ghosted). Also skips empty messages.
 */
function buildPassageFromRange(chat, startIdx, endIdx) {
    const lines = [];
    for (let i = startIdx; i <= endIdx; i++) {
        const m = chat[i];
        if (!m) continue;
        if (!m.mes || !m.mes.trim()) continue;

        // Skip messages hidden by the user (not by us)
        // A message hidden by the user will be is_system/is_hidden but NOT sc_ghosted
        // A message hidden by us will have sc_ghosted = true
        const isUserHidden = (m.is_system || m.is_hidden) && !m.extra?.sc_ghosted;
        if (isUserHidden) continue;

        const speaker = m.is_user ? 'Player' : 'Assistant';
        lines.push(`${speaker}: ${m.mes.trim()}`);
    }
    return lines.join('\n');
}

/**
 * Build a full context string from all layers down to (and including) a target layer.
 * Deepest layers first, target layer last — gives the summarizer full awareness
 * of what's already been captured so it can avoid redundancy.
 *
 * @param {number} downToLayer - Include this layer and all layers above it
 * @returns {string} - Combined context string, or '(none yet)'
 */
function buildFullContext(downToLayer = 0) {
    const store = getChatStore();
    const parts = [];

    for (let i = store.layers.length - 1; i >= downToLayer; i--) {
        const layer = store.layers[i];
        if (!layer || layer.length === 0) continue;
        for (const sn of layer) {
            parts.push(sn.text);
        }
    }

    return parts.length > 0 ? parts.join(' ') : '(none yet)';
}

// ─── Prompt Toggle Management ────────────────────────────────────────

function snapshotPromptToggles() {
    const snapshot = new Map();
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) {
            log('No prompt manager available, skipping toggle snapshot.');
            return snapshot;
        }
        const collection = promptManager.getPromptCollection();
        if (!collection?.collection) return snapshot;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return snapshot;
        for (const entry of collection.collection) {
            for (const orderEntry of orderList) {
                if (orderEntry.identifier === entry.identifier) {
                    snapshot.set(entry.identifier, orderEntry.enabled);
                }
            }
        }
        log(`Snapshot captured: ${snapshot.size} prompt toggles`);
    } catch (e) {
        log('Error capturing snapshot:', e);
    }
    return snapshot;
}

function disableAllPromptToggles() {
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (entry.enabled) {
                entry.enabled = false;
                count++;
            }
        }
        log(`Disabled ${count} prompt toggles`);
    } catch (e) {
        log('Error disabling prompt toggles:', e);
    }
}

function restorePromptToggles(snapshot) {
    if (!snapshot || snapshot.size === 0) return;
    try {
        const ctx = SillyTavern.getContext();
        const promptManager = ctx.promptManager;
        if (!promptManager) return;
        const orderList = promptManager.getPromptOrderEntries();
        if (!orderList) return;
        let count = 0;
        for (const entry of orderList) {
            if (snapshot.has(entry.identifier)) {
                entry.enabled = snapshot.get(entry.identifier);
                count++;
            }
        }
        log(`Restored ${count} prompt toggles`);
    } catch (e) {
        log('Error restoring prompt toggles:', e);
    }
}

// ─── Output Cleaning ─────────────────────────────────────────────────

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 */
function cleanSummarizerOutput(raw) {
    let text = raw;

    const s = getSettings();

    // Remove configurable strip patterns
    for (const pattern of s.stripPatterns) {
        while (text.includes(pattern)) {
            text = text.replace(pattern, '');
        }
    }

    // Remove common reasoning blocks (content between tag pairs)
    const blockPatterns = [
        /<\|channel>thought[\s\S]*?<channel\|>/gi,
        /<thinking>[\s\S]*?<\/thinking>/gi,
        /<output>([\s\S]*?)<\/output>/gi,
        /<reasoning>[\s\S]*?<\/reasoning>/gi,
        /<thought>[\s\S]*?<\/thought>/gi,
        /<reflect>[\s\S]*?<\/reflect>/gi,
        /<inner_monologue>[\s\S]*?<\/inner_monologue>/gi,
    ];

    for (const regex of blockPatterns) {
        // For <output> tags, keep the content inside
        if (regex.source.includes('output')) {
            text = text.replace(regex, '$1');
        } else {
            text = text.replace(regex, '');
        }
    }

    // Clean up leftover whitespace
    text = text.replace(/\n{3,}/g, '\n').trim();

    return text;
}

// ─── Core: Summarization State ───────────────────────────────────────

let isSummarizing = false;
let catchupDismissed = false;
let currentAbortController = null;

function abortSummarization() {
    if (currentAbortController) {
        currentAbortController.abort();
        log('Abort signal sent.');
    }
    isSummarizing = false;
}

// ─── Core: LLM Summarization with Retry ──────────────────────────────

async function callSummarizer(storyTxt, contextStr, opts = {}) {
    trace('>>> ENTERING callSummarizer');
    trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
    trace('  contextStr length:', contextStr?.length ?? 'UNDEFINED');

    const s = getSettings();
    trace('  settings loaded:', {
        connectionSource: s.connectionSource,
        enabled: s.enabled,
    });

    const sysPrompt = opts.systemPrompt || s.summarizerSystemPrompt;
    const userTpl = opts.userPrompt || s.summarizerUserPrompt;
    let prompt = userTpl
        .replace('{{player_name}}', getPlayerName())
        .replace('{{context_str}}', contextStr || '(none yet)')
        .replace('{{story_txt}}', storyTxt);
    if (userTpl.includes('{{snippet}}')) prompt = prompt.replace('{{snippet}}', opts.snippet || '(none)');

    log('── Summarizer Call ──');
    log('Context str length:', contextStr.length, 'chars');
    log('Story txt length:', storyTxt.length, 'chars');

    const isDefaultMode = !s.connectionSource || s.connectionSource === 'default';
    const snapshot = isDefaultMode ? snapshotPromptToggles() : null;
    if (isDefaultMode) disableAllPromptToggles();

    currentAbortController = new AbortController();
    const { signal } = currentAbortController;

    let lastError = null;

    try {
        for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
            trace(`  Attempt ${attempt} starting...`);

            if (signal.aborted) {
                log('Summarization aborted by user.');
                toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: 3000 });
                return '';
            }

            try {
                if (attempt > 0) {
                    log(`Retry attempt ${attempt}/${RETRY_CONFIG.maxRetries}`);
                }

                trace(`  About to call sendSummarizerRequest with:`, {
                    connectionSource: s.connectionSource,
                    summarizerSystemPrompt: s.summarizerSystemPrompt?.substring(0, 50),
                    promptLength: prompt.length,
                });

                const timeoutMs = 120000;
                const result = await Promise.race([
                    sendSummarizerRequest(s, sysPrompt, prompt),
                    new Promise((_, reject) => {
                        const timer = setTimeout(() => reject(new Error('Request timed out after 120s')), timeoutMs);
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            reject(new Error('Aborted by user'));
                        });
                    }),
                ]);

                trace('  sendSummarizerRequest returned:', result?.substring?.(0, 50));

                let trimmed = (result || '').trim();
                trimmed = cleanSummarizerOutput(trimmed);

                if (!trimmed) {
                    log('Empty response from LLM, treating as retryable');
                    throw new Error('Empty response from summarizer');
                }

                log('Result:', trimmed);
                trace('<<< EXITING callSummarizer WITH SUCCESS');
                return trimmed;

            } catch (err) {
                lastError = err;
                trace(`  Caught error on attempt ${attempt}:`, {
                    name: err?.name,
                    message: err?.message,
                    retryable: err?.retryable,
                });

                if (signal.aborted || err.message === 'Aborted by user') {
                    log('Summarization aborted by user.');
                    toastr.warning('Summarization aborted.', 'Summaryception', { timeOut: 3000 });
                    return '';
                }

                if (!isRetryableError(err)) {
                    trace('  ERROR IS NON-RETRYABLE, BREAKING');
                    console.error(LOG_PREFIX, 'Non-retryable error:', err);
                    break;
                }

                if (attempt >= RETRY_CONFIG.maxRetries) {
                    trace('  MAX RETRIES EXHAUSTED');
                    console.error(LOG_PREFIX, `All ${RETRY_CONFIG.maxRetries} retries exhausted.`);
                    break;
                }

                let delay;
                const retryAfterMs = parseRetryAfter(err);
                if (retryAfterMs) {
                    delay = Math.min(retryAfterMs, RETRY_CONFIG.maxDelay);
                    log(`Server requested retry after ${delay}ms`);
                } else {
                    const exponentialDelay = RETRY_CONFIG.baseDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
                    const jitter = Math.random() * RETRY_CONFIG.baseDelay;
                    delay = Math.min(exponentialDelay + jitter, RETRY_CONFIG.maxDelay);
                }

                const delaySec = (delay / 1000).toFixed(1);
                const status = err?.status || err?.response?.status || '?';

                console.warn(LOG_PREFIX, `Attempt ${attempt + 1} failed (${status}). Retrying in ${delaySec}s...`, err.message || err);

                toastr.warning(
                    `API error (${status}). Retrying in ${delaySec}s... (${attempt + 1}/${RETRY_CONFIG.maxRetries})`,
                    'Summaryception',
                    { timeOut: delay }
                );

                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, delay);
                    signal.addEventListener('abort', () => {
                        clearTimeout(timer);
                        resolve();
                    });
                });
            }
        }

        const status = lastError?.status || lastError?.response?.status || '';
        console.error(LOG_PREFIX, 'Summarization failed after all retries:', lastError);
        toastr.error(
            `Summarization failed after ${RETRY_CONFIG.maxRetries} retries${status ? ` (${status})` : ''}. Batch skipped — will retry on next trigger.`,
            'Summaryception',
            { timeOut: 8000 }
        );
        trace('<<< EXITING callSummarizer WITH FAILURE');
        return '';

    } finally {
        currentAbortController = null;
        if (isDefaultMode && snapshot) {
            restorePromptToggles(snapshot);
        }
    }
}

// ─── Detail Auditor ("sister") ───────────────────────────────────────
// A second, per-batch pass that checks whether the compact snippet dropped
// important specifics from the same passage. Reuses callSummarizer's machinery
// via prompt overrides. Returns '' (no detail) or a short note. Non-fatal.

function normalizeAuditorOutput(raw) {
    let t = (raw || '').trim();
    if (!t) return '';
    // Strip an optional leading "DETAIL:" label the model may include.
    t = t.replace(/^\s*DETAIL\s*[:\-–]?\s*/i, '').trim();
    // Treat an explicit "nothing to add" as empty.
    if (/^\(?\s*(none|n\/?a|nothing|no( new)? detail[s]?( needed)?)\s*\)?[.!]?$/i.test(t)) return '';
    return t;
}

async function callAuditor(storyTxt, snippetText, contextStr) {
    const s = getSettings();
    const raw = await callSummarizer(storyTxt, contextStr, {
        systemPrompt: s.sisterSystemPrompt,
        userPrompt: s.sisterUserPrompt,
        snippet: snippetText,
    });
    return normalizeAuditorOutput(raw);
}

// Queue the auditor for the snippet just pushed to Layer 0 and return IMMEDIATELY.
// The audit runs in the background (sequentially, one at a time) so the
// summarize→ghost cycle finishes at full speed — the detail note attaches when
// ready. If the snippet is promoted/deleted/chat-switched before the audit
// lands, the result is safely discarded. Never throws upward.
let _auditQueue = [];
let _auditActive = false;

function queueAuditDetail(storyTxt, snippetText, contextStr) {
    const s = getSettings();
    if (!s.sisterEnabled) return;
    const store = getChatStore();
    const layer0 = store.layers && store.layers[0];
    if (!layer0 || layer0.length === 0) return;
    _auditQueue.push({ snip: layer0[layer0.length - 1], storyTxt, snippetText, contextStr });
    processAuditQueue();   // fire and forget — deliberately NOT awaited
}

async function processAuditQueue() {
    if (_auditActive) return;
    _auditActive = true;
    try {
        while (_auditQueue.length > 0) {
            const job = _auditQueue.shift();
            try {
                const detail = await callAuditor(job.storyTxt, job.snippetText, job.contextStr);
                // Re-check the world: the snippet may have been promoted, deleted,
                // or we may have switched chats while the audit was in flight.
                const store = getChatStore();
                const layer0 = store.layers && store.layers[0];
                if (!layer0 || !layer0.includes(job.snip)) {
                    log('Detail auditor: snippet no longer in Layer 0 — result discarded.');
                    continue;
                }
                if (detail) {
                    job.snip.detail = detail;
                    await saveChatStore();
                    updateInjection();
                    log(`Detail auditor (background): attached ${detail.length} chars.`);
                } else {
                    log('Detail auditor (background): snippet already complete — no detail added.');
                }
            } catch (e) {
                log('Detail auditor (background) failed for one snippet — kept without detail:', e);
            }
        }
    } finally {
        _auditActive = false;
    }
}

// ─── Core: Summarize Oldest Verbatim Turns ──────────────────────────

async function maybeSummarizeTurns() {
    const s = getSettings();
    if (!s.enabled) return;
    if (s.pauseSummarization) return;  // ← new
    if (isSummarizing) return;

    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    const allAssistantTurns = getAssistantTurns(chat);
    const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

    log(`Visible assistant turns: ${visibleTurns.length}, limit: ${s.verbatimTurns}`);

    if (visibleTurns.length <= s.verbatimTurns) return;

    const overflow = visibleTurns.length - s.verbatimTurns;

    // ─── Backlog detection ───────────────────────────────────────
    const backlogThreshold = s.turnsPerSummary * 2;

    if (overflow > backlogThreshold && !catchupDismissed) {
        log(`Large backlog detected: ${overflow} turns over limit`);

        const batchesNeeded = Math.ceil(overflow / s.turnsPerSummary);
        const choice = await showCatchupDialog(overflow, batchesNeeded);

        if (choice === 'skip') {
            const cutoff = visibleTurns[visibleTurns.length - s.verbatimTurns - 1];
            if (cutoff) {
                store.summarizedUpTo = cutoff.index;
                log(`Skipped backlog. summarizedUpTo set to ${store.summarizedUpTo}`);
            }
            catchupDismissed = true;
            await saveChatStore();
            return;
        } else if (choice === 'catchup') {
            await runCatchup(visibleTurns, overflow);
            return;
        } else if (choice === 'partial') {
            await summarizeOneBatch(visibleTurns);
            return;
        }
        return;
    }

    // ─── Normal operation: single batch ──────────────────────────
    const success = await summarizeOneBatch(visibleTurns);

    if (!success) {
        log('Batch failed, stopping summarization cycle to avoid retry loop.');
        return;
    }

    const remaining = getAssistantTurns(chat).filter(t => !chat[t.index].extra?.sc_ghosted);
    if (remaining.length > s.verbatimTurns && remaining.length - s.verbatimTurns <= backlogThreshold) {
        await maybeSummarizeTurns();
    }
}

// ─── Core: Single Batch Summarization ────────────────────────────────

async function summarizeOneBatch(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatch');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // ─── FIX: Filter out turns that are at or before summarizedUpTo ───
    const eligibleTurns = visibleTurns.filter(t => t.index > store.summarizedUpTo);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        log('All visible turns are already summarized — repairing ghosting...');
        const turnsToGhost = visibleTurns.filter(t => t.index <= store.summarizedUpTo);
        for (const t of turnsToGhost) {
            await ghostMessage(t.index);
        }
        await saveChatStore();
        trace('<<< EXITING summarizeOneBatch - REPAIRED GHOSTING');
        return false;
    }

    const batchSize = Math.min(s.turnsPerSummary, eligibleTurns.length);
    const batch = eligibleTurns.slice(0, batchSize);

    if (batch.length === 0) {
        trace('<<< EXITING summarizeOneBatch - EMPTY BATCH');
        return false;
    }

    isSummarizing = true;

    try {
        const startIdx = batch[0].index;
        const endIdx = batch[batch.length - 1].index;
        trace('  startIdx:', startIdx, 'endIdx:', endIdx);
        trace('  store.summarizedUpTo:', store.summarizedUpTo);

        log(`Summarizing ${batch.length} assistant turns (indices ${startIdx}–${endIdx})`);

        if (!store.layers[0]) store.layers[0] = [];
        const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

        // ─── SANITY CHECK ───
        if (passageStart > endIdx) {
            log(`ERROR: passageStart (${passageStart}) > endIdx (${endIdx}). Batch already summarized?`);
            trace('<<< EXITING summarizeOneBatch - PASSAGE START GREATER THAN END');
            return false;
        }

        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  storyTxt length:', storyTxt?.length ?? 'UNDEFINED');
        if (!storyTxt.trim()) {
            trace('<<< EXITING summarizeOneBatch - EMPTY PASSAGE');
            return false;
        }

        const contextStr = buildFullContext(0);

        toastr.info(`Summarizing ${batch.length} turn${batch.length > 1 ? 's' : ''}…`, 'Summaryception', {
            timeOut: 3000,
            progressBar: true,
        });

        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  summary length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('<<< EXITING summarizeOneBatch - EMPTY SUMMARY');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
        await ghostMessagesUpTo(endIdx);

        // Sister pass: check the snippet for dropped specifics; attach a detail note if any.
        queueAuditDetail(storyTxt, summary, contextStr);   // non-blocking: audit runs in background

        log(`Layer 0 now has ${store.layers[0].length} snippets`);

        await maybePromoteLayer(0);
        await saveChatStore();

        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }

        toastr.success(`Summary saved (Layer 0: ${store.layers[0].length} snippets)`, 'Summaryception', { timeOut: 2000 });
        trace('<<< EXITING summarizeOneBatch - SUCCESS');
        return true;

    } finally {
        isSummarizing = false;
    }
}

// ─── Core: Inner Batch for Catchup ───────────────────────────────────

async function summarizeOneBatchFromTurns(visibleTurns) {
    trace('>>> ENTERING summarizeOneBatchFromTurns');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');

    const s = getSettings();
    const { chat } = SillyTavern.getContext();
    const store = getChatStore();

    // ─── FIX: Filter out turns that are at or before summarizedUpTo ───
    // This handles desync where summarizedUpTo advanced but ghosting failed
    // (e.g., connection drop mid-summarization). Without this filter, the batch
    // always starts at the first un-ghosted turn, gets rejected by the
    // startIdx <= summarizedUpTo guard, and loops forever.
    const eligibleTurns = visibleTurns.filter(t => t.index > store.summarizedUpTo);
    trace('  eligibleTurns after filtering:', eligibleTurns.length);

    if (eligibleTurns.length === 0) {
        // All "visible" turns are actually already summarized but not ghosted.
        // Ghost them now to fix the desync.
        log('All visible turns are already summarized — repairing ghosting...');
        const turnsToGhost = visibleTurns.filter(t => t.index <= store.summarizedUpTo);
        for (const t of turnsToGhost) {
            await ghostMessage(t.index);
        }
        await saveChatStore();
        trace('<<< EXITING summarizeOneBatchFromTurns - REPAIRED GHOSTING');
        return false;
    }

    const batchSize = Math.min(s.turnsPerSummary, eligibleTurns.length);
    const batch = eligibleTurns.slice(0, batchSize);

    trace('  batchSize:', batchSize);
    trace('  batch prepared:', batch.length);

    if (batch.length === 0) {
        trace('<<< EXITING summarizeOneBatchFromTurns - EMPTY BATCH');
        return false;
    }

    const startIdx = batch[0].index;
    const endIdx = batch[batch.length - 1].index;

    trace('  startIdx:', startIdx, 'endIdx:', endIdx);
    trace('  store.summarizedUpTo:', store.summarizedUpTo);

    if (!store.layers[0]) store.layers[0] = [];

    // ─── Start from the message AFTER the last summarized one ───
    const passageStart = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;

    trace('  passageStart:', passageStart, 'endIdx:', endIdx);

    // ─── SANITY CHECK: passageStart should always be <= endIdx ───
    if (passageStart > endIdx) {
        trace('  CRITICAL: passageStart > endIdx! This should never happen.');
        trace('  This likely means the batch was already summarized.');
        trace('<<< EXITING - passageStart > endIdx');
        return false;
    }

    trace('  About to call buildPassageFromRange...');

    try {
        const storyTxt = buildPassageFromRange(chat, passageStart, endIdx);
        trace('  buildPassageFromRange returned, length:', storyTxt?.length ?? 'UNDEFINED');

        if (!storyTxt.trim()) {
            trace('  <<< EXITING - storyTxt is empty after trim');
            trace('  This suggests all messages in range [' + passageStart + ', ' + endIdx + '] are hidden or empty');
            return false;
        }

        trace('  About to call buildFullContext...');
        const contextStr = buildFullContext(0);
        trace('  buildFullContext returned, length:', contextStr?.length ?? 'UNDEFINED');

        trace('  About to call callSummarizer...');
        const summary = await callSummarizer(storyTxt, contextStr);
        trace('  callSummarizer returned, length:', summary?.length ?? 'UNDEFINED');

        if (!summary) {
            log('Summarization failed for batch, leaving turns intact for next attempt.');
            trace('  <<< EXITING - summary is empty');
            return false;
        }

        store.layers[0].push({
            text: summary,
            turnRange: [passageStart, endIdx],
            timestamp: Date.now(),
        });

        store.summarizedUpTo = Math.max(store.summarizedUpTo, endIdx);
        trace('  Updated store.summarizedUpTo to:', store.summarizedUpTo);

        await saveChatStore();
        await ghostMessagesUpTo(endIdx);

        // Sister pass: check the snippet for dropped specifics; attach a detail note if any.
        queueAuditDetail(storyTxt, summary, contextStr);   // non-blocking: audit runs in background

        await maybePromoteLayer(0);
        await saveChatStore();

        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }

        trace('<<< EXITING summarizeOneBatchFromTurns - SUCCESS');
        return true;

    } catch (err) {
        trace('  CAUGHT EXCEPTION:', {
            name: err?.name,
            message: err?.message,
            stack: err?.stack?.substring?.(0, 200),
        });
        console.error(LOG_PREFIX, 'summarizeOneBatchFromTurns exception:', err);
        trace('<<< EXITING summarizeOneBatchFromTurns - EXCEPTION');
        return false;
    }
}

// ─── Core: Catchup Processing ────────────────────────────────────────

async function runCatchup(visibleTurns, overflow) {

    trace('>>> ENTERING runCatchup');
    trace('  visibleTurns:', visibleTurns?.length ?? 'UNDEFINED');
    trace('  overflow:', overflow);

    const s = getSettings();
    const totalBatches = Math.ceil(overflow / s.turnsPerSummary);
    let completed = 0;
    let failed = 0;
    let cancelled = false;

    trace('  totalBatches calculated:', totalBatches);

    const progressToast = toastr.info(
        `Processing backlog: 0 / ${totalBatches} batches (0%)`,
        'Summaryception Catch-Up',
        {
            timeOut: 0,
            extendedTimeOut: 0,
            tapToDismiss: false,
            closeButton: true,
            onCloseClick: () => {
                cancelled = true;
                abortSummarization();
            },
        }
    );

    isSummarizing = true;

    try {
        let consecutiveFailures = 0;

        while (!cancelled) {
            trace(`  Loop iteration - completed: ${completed}, failed: ${failed}`);

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const currentVisible = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

            trace(`  currentVisible turns: ${currentVisible.length}, verbatimTurns limit: ${s.verbatimTurns}`);

            if (currentVisible.length <= s.verbatimTurns) {
                trace('  Visible turns now within limit, breaking');
                break;
            }

            trace('  About to call summarizeOneBatchFromTurns...');
            const success = await summarizeOneBatchFromTurns(currentVisible);

            if (success) {
                trace('  >>> summarizeOneBatchFromTurns returned SUCCESS');
                completed++;
                consecutiveFailures = 0;
            } else {
                trace('  >>> summarizeOneBatchFromTurns returned FAILURE');
                failed++;
                consecutiveFailures++;

                if (consecutiveFailures >= 3) {
                    toastr.error(
                        '3 consecutive failures — API may be down. Pausing catch-up. Progress saved; will resume on next message.',
                        'Summaryception',
                        { timeOut: 8000 }
                    );
                    trace('  3 consecutive failures, breaking');
                    break;
                }
            }

            const pct = Math.round((completed / totalBatches) * 100);
            const failStr = failed > 0 ? ` | ${failed} failed` : '';
            $(progressToast).find('.toast-message').text(
                `Processing: ${completed} / ${totalBatches} batches (${pct}%)${failStr}\nClick ✕ to pause`
            );

            await new Promise(r => setTimeout(r, 200));
        }

        toastr.clear(progressToast);

        if (cancelled) {
            toastr.warning(
                `Catch-up paused at ${completed}/${totalBatches}. Progress saved — will continue on next message.`,
                'Summaryception',
                { timeOut: 5000 }
            );
        } else if (failed === 0) {
            toastr.success(
                `Catch-up complete! ${completed} batches processed.`,
                'Summaryception',
                { timeOut: 4000 }
            );
        } else {
            toastr.warning(
                `Catch-up finished. ${completed} succeeded, ${failed} failed (will retry on next trigger).`,
                'Summaryception',
                { timeOut: 6000 }
            );
        }

        updateUI();

    } finally {
        isSummarizing = false;
    }
}

// ─── Catch-Up Dialog ─────────────────────────────────────────────────

async function showCatchupDialog(overflowCount, estimatedCalls) {
    return new Promise((resolve) => {
        const s = getSettings();

        const overlay = document.createElement('div');
        overlay.className = 'sc-catchup-overlay';
        overlay.innerHTML = `
        <div class="sc-catchup-modal">
        <h3>🧠 Summaryception — Backlog Detected</h3>
        <div class="sc-catchup-dialog">
        <p>Summaryception detected <strong>${overflowCount} unsummarized turns</strong>
        in this chat (beyond your ${s.verbatimTurns} verbatim limit).</p>
        <p>This will require approximately <strong>${estimatedCalls} summarizer calls</strong> to process.</p>
        <hr>
        <div class="sc-catchup-options">
        <button id="sc_catchup_full" class="menu_button">
        <i class="fa-solid fa-forward-fast"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Process Entire Backlog</span>
        <span class="sc-btn-desc">Summarize all ${overflowCount} turns — cancelable at any time</span>
        </div>
        </button>
        <button id="sc_catchup_skip" class="menu_button">
        <i class="fa-solid fa-forward-step"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Skip Backlog</span>
        <span class="sc-btn-desc">Ignore old turns, only summarize new ones going forward</span>
        </div>
        </button>
        <button id="sc_catchup_partial" class="menu_button">
        <i class="fa-solid fa-play"></i>
        <div class="sc-btn-text">
        <span class="sc-btn-label">Just One Batch</span>
        <span class="sc-btn-desc">Summarize ${s.turnsPerSummary} turns now, deal with the rest later</span>
        </div>
        </button>
        </div>
        </div>
        </div>
        `;
        document.body.appendChild(overlay);

        overlay.querySelector('#sc_catchup_full').addEventListener('click', () => {
            overlay.remove();
            resolve('catchup');
        });
        overlay.querySelector('#sc_catchup_skip').addEventListener('click', () => {
            overlay.remove();
            resolve('skip');
        });
        overlay.querySelector('#sc_catchup_partial').addEventListener('click', () => {
            overlay.remove();
            resolve('partial');
        });
    });
}

// ─── Core: Layer Promotion ("ception") ──────────────────────────────

async function maybePromoteLayer(layerIndex) {
    const s = getSettings();
    const store = getChatStore();

    if (layerIndex >= s.maxLayers - 1) {
        log(`Max layer depth (${s.maxLayers}) reached.`);
        return;
    }

    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) return;

    log(`Layer ${layerIndex}: ${layer.length} snippets > limit ${s.snippetsPerLayer} → promoting`);

    if (!store.layers[layerIndex + 1]) store.layers[layerIndex + 1] = [];
    const destLayer = store.layers[layerIndex + 1];

    if (destLayer.length === 0) {
        const seed = layer.shift();
        seed.promoted = true;
        seed.seedFromLayer = layerIndex;
        destLayer.push(seed);

        log(`Seeded Layer ${layerIndex + 1} with oldest snippet from Layer ${layerIndex} (no LLM call)`);

        toastr.info(
            `Seeded Layer ${layerIndex + 1} from Layer ${layerIndex} (free promotion)`,
            'Summaryception',
            { timeOut: 2000 }
        );

        if (layer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex);
        }
        if (destLayer.length > s.snippetsPerLayer) {
            await maybePromoteLayer(layerIndex + 1);
        }
        return;
    }

    const toMerge = layer.splice(0, s.snippetsPerPromotion);
    const storyTxt = toMerge.map(sn => sn.text).join(' ');
    const contextStr = buildFullContext(layerIndex + 1);

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true }
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr);
    if (!metaSummary) {
        layer.unshift(...toMerge);
        return;
    }

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });

    log(`Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex + 1);
    }
}

// ─── Core: Assemble Full Summary Block ──────────────────────────────

function assembleSummaryBlock() {
    const s = getSettings();
    const store = getChatStore();

    // ── Manual notepad — per-chat story/lore memory (survives branches) ──
    let notesPart = '';
    if (store.notepad && store.notepad.trim().length > 0) {
        const tpl = s.notepadTemplate || '\n\n<notes>\n{{notes}}\n</notes>\n';
        notesPart = tpl.replace('{{notes}}', store.notepad.trim());
    }

    // ── Auto-generated layered summary ──
    let summaryPart = '';
    if (store.layers && !store.layers.every(l => !l || l.length === 0)) {
        const snippets = [];
        for (let i = store.layers.length - 1; i >= 1; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) continue;
            for (const sn of layer) snippets.push(sn.text);
        }
        if (store.layers[0] && store.layers[0].length > 0) {
            for (const sn of store.layers[0]) snippets.push(sn.text);
        }
        if (snippets.length > 0) {
            summaryPart = s.injectionTemplate.replace('{{summary}}', snippets.join(' '));
        }
    }

    // ── Sister detail notes — the specifics the compact snippets dropped, for
    //    recent (Layer 0) events. Rides along with the summary, clearly marked. ──
    let detailPart = '';
    if (s.sisterEnabled && store.layers && store.layers[0]) {
        const notes = store.layers[0]
            .filter(sn => sn.detail && sn.detail.trim())
            .map(sn => '- ' + sn.detail.trim());
        if (notes.length > 0) {
            const tpl = s.sisterInjectTemplate || '\n\n<details>\n{{details}}\n</details>\n';
            detailPart = tpl.replace('{{details}}', notes.join('\n'));
        }
    }

    // Notepad first (stable canon), then the summary (gist), then details (specifics).
    return notesPart + summaryPart + detailPart;
}

// ─── Injection via setExtensionPrompt ────────────────────────────────

let _lastInjected = '';

function updateInjection(force = false) {
    try {
        const { setExtensionPrompt } = SillyTavern.getContext();
        const s = getSettings();

        const pos  = (s.injectionPosition ?? 1);
        const dep  = (s.injectionDepth ?? 4);
        const role = (s.injectionRole ?? 0);

        if (!s.enabled) {
            if (_lastInjected !== '' || force) {
                setExtensionPrompt(MODULE_NAME, '', pos, dep, false, role);
                _lastInjected = '';
            }
            return;
        }

        const summaryBlock = assembleSummaryBlock();
        // `force` bypasses the cache — required on chat/branch switch, because a
        // branch inherits the parent's metadata so the block is byte-identical to
        // what was last injected, and the plain equality check would skip re-injection.
        if (!force && summaryBlock === _lastInjected) return;

        setExtensionPrompt(MODULE_NAME, summaryBlock || '', pos, dep, false, role);
        _lastInjected = summaryBlock || '';

        log(`Injection updated: ${(summaryBlock || '').length} chars @ pos ${pos} depth ${dep}`);
    } catch (e) {
        log('updateInjection error:', e);
    }
}

// ─── Event Handlers ──────────────────────────────────────────────────

function onMessageReceived(messageIndex) {
    try {
        const { chat } = SillyTavern.getContext();
        const msg = chat[messageIndex];
        if (msg && !msg.is_user && !msg.is_system) {
            log('New assistant message at index', messageIndex);
            setTimeout(async () => {
                await maybeSummarizeTurns();
                updateInjection();
                updateUI();
            }, 500);
        }
    } catch (e) {
        log('onMessageReceived error:', e);
    }
}

function onChatChanged() {
    log('Chat changed.');
    catchupDismissed = false;
    setTimeout(async () => {
        await repairIfBranched();
        updateInjection(true);   // force — new branch/chat needs re-injection past the cache
        updateUI();
    }, 200);
}

function onGenerationStarted() {
    // Force so the injection is guaranteed present at prompt-build time, even if
    // a branch/chat switch left it stale or cleared. This removes the need to
    // toggle enabled/pause or refresh the page after branching.
    updateInjection(true);
}

// ─── Slash Commands ──────────────────────────────────────────────────

function registerSlashCommands() {
    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.SlashCommandParser?.addCommandObject || !ctx.SlashCommand) {
            log('SlashCommandParser not available, skipping command registration.');
            return;
        }

        const { SlashCommandParser, SlashCommand } = ctx;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-status',
            callback: () => {
                const store = getChatStore();
                const lines = ['**Summaryception Status**'];
                lines.push(`Summarized up to index: ${store.summarizedUpTo}`);
                if (store.layers) {
                    for (let i = 0; i < store.layers.length; i++) {
                        const l = store.layers[i];
                        if (l && l.length > 0) {
                            lines.push(`Layer ${i}: ${l.length} snippets`);
                        }
                    }
                }
                return lines.join('\n');
            },
            helpString: 'Show Summaryception layer status',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-clear',
            callback: async () => {
                await unghostAllMessages();

                const store = getChatStore();
                store.layers.length = 0;
                store.summarizedUpTo = -1;
                store.ghostedIndices = [];

                const { chatMetadata } = SillyTavern.getContext();
                chatMetadata[MODULE_NAME] = store;

                await saveChatStore();
                try {
                    const ctx2 = SillyTavern.getContext();
                    if (ctx2.saveChat) await ctx2.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                return 'Summaryception memory cleared and messages unghosted.';
            },
            helpString: 'Clear all Summaryception memory and unghost messages for this chat',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'sc-preview',
            callback: () => {
                return assembleSummaryBlock() || '(No summaries yet)';
            },
            helpString: 'Preview the summary block that would be injected',
        }));
    } catch (e) {
        log('Could not register slash commands:', e);
    }
}

// ─── Settings UI ─────────────────────────────────────────────────────

function updateUI() {
    try {
        const s = getSettings();
        const store = getChatStore();

        $('#sc_enabled').prop('checked', s.enabled);
        $('#sc_pause_summarization').prop('checked', s.pauseSummarization);
        $('#sc_disable_ghosting').prop('checked', s.disableGhosting);
        $('#sc_verbatim_turns').val(s.verbatimTurns);
        $('#sc_verbatim_turns_val').text(s.verbatimTurns);
        $('#sc_turns_per_summary').val(s.turnsPerSummary);
        $('#sc_turns_per_summary_val').text(s.turnsPerSummary);
        $('#sc_snippets_per_layer').val(s.snippetsPerLayer);
        $('#sc_snippets_per_layer_val').text(s.snippetsPerLayer);
        $('#sc_snippets_per_promotion').val(s.snippetsPerPromotion);
        $('#sc_snippets_per_promotion_val').text(s.snippetsPerPromotion);
        $('#sc_max_layers').val(s.maxLayers);
        $('#sc_max_layers_val').text(s.maxLayers);
        $('#sc_injection_template').val(s.injectionTemplate);
        $('#sc_injection_position').val(String(s.injectionPosition ?? 1));
        $('#sc_injection_depth').val(s.injectionDepth ?? 4);
        $('#sc_injection_depth_val').text(s.injectionDepth ?? 4);
        $('#sc_notepad').val(store.notepad || '');
        $('#sc_summarizer_system_prompt').val(s.summarizerSystemPrompt);
        $('#sc_summarizer_user_prompt').val(s.summarizerUserPrompt);
        $('#sc_sister_enabled').prop('checked', s.sisterEnabled !== false);
        $('#sc_sister_system_prompt').val(s.sisterSystemPrompt);
        $('#sc_sister_user_prompt').val(s.sisterUserPrompt);
        $('#sc_editor_system_prompt').val(s.editorSystemPrompt);
        $('#sc_editor_user_prompt').val(s.editorUserPrompt);
        // ── Prompt preset migration & sync ──
        // Migration: existing users with the old game-state default get upgraded to narrative.
        // Users who customized their prompt get marked as 'custom'.
        if (!s.promptPreset) {
            const currentPrompt = (s.summarizerUserPrompt || '').trim();
            const gameStatePrompt = PROMPT_PRESETS.gamestate.trim();

            if (!currentPrompt || currentPrompt === gameStatePrompt) {
                // User had the old default — upgrade to narrative
                s.promptPreset = 'narrative';
                s.summarizerUserPrompt = PROMPT_PRESETS.narrative;
                saveSettings();
            } else {
                // User customized their prompt — mark as custom
                s.promptPreset = 'custom';
                saveSettings();
            }
        }

        $('#sc_prompt_preset').val(s.promptPreset);
        $('#sc_debug_mode').prop('checked', s.debugMode);
        $('#sc_trace_mode').prop('checked', s.traceMode);
        $('#sc_strip_patterns').val((s.stripPatterns || []).join('\n'));
        $('#sc_summarizer_response_length').val(s.summarizerResponseLength || 0);

        let ghostedCount = 0;
        try {
            const { chat } = SillyTavern.getContext();
            ghostedCount = chat.filter(m => m.extra?.sc_ghosted).length;
        } catch (e) { /* no chat loaded */ }

        let statsHtml = '';
        if (s.disableGhosting) {
            statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (metadata only — not visually hidden)</div>`;
        } else {
            statsHtml += `<div class="sc-layer-stat">👻 <strong>${ghostedCount}</strong> messages ghosted (hidden from LLM, visible to you)</div>`;
        }
        if (store.layers) {
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const layer = store.layers[i];
                if (layer && layer.length > 0) {
                    const label = i === 0 ? 'Layer 0 (turn summaries)' : `Layer ${i} (depth ${i} meta)`;
                    statsHtml += `<div class="sc-layer-stat">
                    <span class="sc-layer-label">${label}:</span>
                    <strong>${layer.length}</strong> / ${s.snippetsPerLayer} snippets
                    </div>`;
                }
            }
        }
        statsHtml += `<div class="sc-layer-stat sc-muted">Summarized up to chat index: ${store.summarizedUpTo ?? -1}</div>`;
        if (!store.layers?.length || store.layers.every(l => !l || l.length === 0)) {
            statsHtml = '<div class="sc-layer-stat sc-muted">No summaries yet for this chat.</div>';
        }

        $('#sc_layer_stats').html(statsHtml);

        const preview = assembleSummaryBlock();
        $('#sc_preview').val(preview || '(empty — no summaries yet)');

        updateSnippetBrowser();
        updateCustomPromptSlots();
    } catch (e) {
        log('updateUI error:', e);
    }
}

function updateCustomPromptSlots() {
    const s = getSettings();
    const select = $('#sc_custom_prompt_slot');
    select.empty().append('<option value="">-- Load a saved prompt --</option>');

    const prompts = s.savedCustomPrompts || {};
    const names = Object.keys(prompts).sort();

    for (const name of names) {
        const preview = prompts[name].substring(0, 60).replace(/\n/g, ' ');
        select.append(
            $('<option></option>')
            .val(name)
            .text(`${name}`)
            .attr('title', preview)
        );
    }

    // Show/hide the prompt manager based on current preset
    if (s.promptPreset === 'custom') {
        $('#sc_custom_prompt_manager').show();
    } else {
        $('#sc_custom_prompt_manager').hide();
    }
}

function updateSnippetBrowser() {
    const store = getChatStore();
    let html = '';

    if (!store.layers || store.layers.every(l => !l || l.length === 0)) {
        html = '<div class="sc-muted">No snippets to display.</div>';
    } else {
        for (let i = store.layers.length - 1; i >= 0; i--) {
            const layer = store.layers[i];
            if (!layer || layer.length === 0) continue;
            const label = i === 0 ? 'Layer 0 (Turn Summaries)' : `Layer ${i} (Meta-Summary)`;
            html += `<div class="sc-browser-layer"><div class="sc-browser-layer-title">${label}</div>`;
            for (let j = 0; j < layer.length; j++) {
                const sn = layer[j];
                const rangeStr = sn.turnRange
                    ? `turns ${sn.turnRange[0]}–${sn.turnRange[1]}`
                    : sn.mergedCount
                        ? `merged ${sn.mergedCount} from L${sn.fromLayer}`
                        : '';
                const seedStr = sn.promoted ? ' 🌱' : '';
                const canRedo = (i === 0 && sn.turnRange);
                const redoBtn = canRedo
                    ? `<button class="sc-snippet-redo menu_button fa-solid fa-rotate-right" title="Regenerate this snippet"></button>`
                    : '';

                // Sister detail row (Layer 0 turn-summaries only)
                let detailRow = '';
                if (i === 0 && sn.turnRange) {
                    const hasDetail = sn.detail && String(sn.detail).trim();
                    const detailText = hasDetail
                        ? `<span class="sc-detail-text" data-layer="${i}" data-idx="${j}" title="Click to edit detail">📝 ${escapeHtml(String(sn.detail).trim())}</span>`
                        : `<span class="sc-detail-empty">no detail</span>`;
                    const detailRedo = `<button class="sc-detail-redo menu_button fa-solid fa-wand-magic-sparkles" title="${hasDetail ? 'Regenerate' : 'Generate'} detail (re-run the sister on these turns)"></button>`;
                    const detailDel = hasDetail
                        ? `<button class="sc-detail-delete menu_button fa-solid fa-eraser" title="Delete this detail"></button>`
                        : '';
                    detailRow = `<div class="sc-detail-row" data-layer="${i}" data-idx="${j}">${detailText}${detailRedo}${detailDel}</div>`;
                }

                html += `<div class="sc-snippet" data-layer="${i}" data-idx="${j}">
                <span class="sc-snippet-text" data-layer="${i}" data-idx="${j}" title="Click to edit">${escapeHtml(sn.text)}</span>
                <span class="sc-snippet-meta">${rangeStr}${seedStr}</span>
                ${redoBtn}
                <button class="sc-snippet-delete menu_button fa-solid fa-xmark" title="Delete this snippet"></button>
                ${detailRow}
                </div>`;
            }
            html += '</div>';
        }
    }

    $('#sc_snippet_browser').html(html);

    // Edit snippet on click
    $('.sc-snippet-text').off('click').on('click', function () {
        const layerIdx = parseInt($(this).data('layer'));
        const snippetIdx = parseInt($(this).data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];
        const textEl = $(this);

        const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
            .val(sn.text)
            .on('keydown', async function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const newText = $(this).val().trim();
                    if (newText) {
                        sn.text = newText;
                        await saveChatStore();
                        updateInjection();
                        toastr.success('Snippet updated', 'Summaryception', { timeOut: 1500 });
                    }
                    updateSnippetBrowser();
                } else if (e.key === 'Escape') {
                    updateSnippetBrowser();
                }
            })
            .on('blur', async function () {
                const newText = $(this).val().trim();
                if (newText && newText !== sn.text) {
                    sn.text = newText;
                    await saveChatStore();
                    updateInjection();
                    toastr.success('Snippet updated', 'Summaryception', { timeOut: 1500 });
                }
                updateSnippetBrowser();
            });

        textEl.replaceWith(textarea);

        // Auto-size to fit content
        textarea[0].style.height = 'auto';
        textarea[0].style.height = textarea[0].scrollHeight + 'px';

        textarea.focus().select();
    });

    // Redo snippet
    $('.sc-snippet-redo').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const store = getChatStore();
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;

        const sn = layer[snippetIdx];

        if (!sn.turnRange) {
            toastr.warning(
                'Only Layer 0 (turn summary) snippets can be regenerated. Promoted meta-summaries have no source turns.',
                'Summaryception',
                { timeOut: 5000 }
            );
            return;
        }

        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.', 'Summaryception');
            return;
        }

        const [rangeStart, rangeEnd] = sn.turnRange;
        const { chat } = SillyTavern.getContext();

        if (!confirm(`Regenerate summary for turns ${rangeStart}–${rangeEnd}?`)) return;

        isSummarizing = true;
        const btn = $(this);
        btn.prop('disabled', true).removeClass('fa-rotate-right').addClass('fa-spinner fa-spin');

        try {
            const storyTxt = buildPassageFromRange(chat, rangeStart, rangeEnd);

            if (!storyTxt.trim()) {
                toastr.error('Source turns are empty — cannot regenerate.', 'Summaryception');
                return;
            }

            const contextParts = [];
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const l = store.layers[i];
                if (!l) continue;
                for (let j = 0; j < l.length; j++) {
                    if (i === layerIdx && j === snippetIdx) continue;
                    contextParts.push(l[j].text);
                }
            }
            const contextStr = contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';

            toastr.info(`Regenerating summary for turns ${rangeStart}–${rangeEnd}…`, 'Summaryception', {
                timeOut: 3000,
                progressBar: true,
            });

            const newSummary = await callSummarizer(storyTxt, contextStr);

            if (!newSummary) {
                toastr.error('Regeneration failed — original snippet kept.', 'Summaryception');
                return;
            }

            sn.text = newSummary;
            sn.timestamp = Date.now();
            sn.regenerated = true;

            await saveChatStore();
            updateInjection();
            updateUI();

            toastr.success(`Snippet regenerated for turns ${rangeStart}–${rangeEnd}`, 'Summaryception', { timeOut: 3000 });

        } finally {
            isSummarizing = false;
            btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-rotate-right');
        }
    });

    // Delete snippet
    $('.sc-snippet-delete').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-snippet').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-snippet').data('idx'));
        const layer = store.layers[layerIdx];
        if (layer) {
            layer.splice(snippetIdx, 1);

            if (store.layers[0] && store.layers[0].length > 0) {
                const maxEnd = Math.max(...store.layers[0]
                    .filter(sn => sn.turnRange)
                    .map(sn => sn.turnRange[1]));
                store.summarizedUpTo = maxEnd;
            } else {
                store.summarizedUpTo = -1;
            }

            await saveChatStore();
            updateInjection();
            updateUI();
            toastr.info(`Snippet removed from Layer ${layerIdx}`, 'Summaryception');
        }
    });

    // Edit detail on click
    $('.sc-detail-text').off('click').on('click', function () {
        const layerIdx = parseInt($(this).data('layer'));
        const snippetIdx = parseInt($(this).data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx]) return;
        const sn = layer[snippetIdx];
        const commit = async (val) => {
            const v = (val || '').trim();
            if (v !== (sn.detail || '')) {
                if (v) sn.detail = v; else delete sn.detail;
                await saveChatStore();
                updateInjection();
                toastr.success('Detail updated', 'Summaryception', { timeOut: 1500 });
            }
        };
        const textarea = $('<textarea class="sc-snippet-edit"></textarea>')
            .val(sn.detail || '')
            .on('keydown', async function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    await commit($(this).val());
                    updateSnippetBrowser();
                } else if (e.key === 'Escape') {
                    updateSnippetBrowser();
                }
            })
            .on('blur', async function () {
                await commit($(this).val());
                updateSnippetBrowser();
            });
        $(this).replaceWith(textarea);
        textarea[0].style.height = 'auto';
        textarea[0].style.height = textarea[0].scrollHeight + 'px';
        textarea.focus().select();
    });

    // Regenerate / generate detail (re-run the sister on the snippet's source turns)
    $('.sc-detail-redo').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-detail-row').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-detail-row').data('idx'));
        const layer = store.layers[layerIdx];
        if (!layer || !layer[snippetIdx] || !layer[snippetIdx].turnRange) return;
        if (isSummarizing) { toastr.warning('Busy summarizing — try again in a moment.', 'Summaryception'); return; }
        const sn = layer[snippetIdx];
        const [rangeStart, rangeEnd] = sn.turnRange;
        const { chat } = SillyTavern.getContext();
        isSummarizing = true;
        const btn = $(this);
        btn.prop('disabled', true).removeClass('fa-wand-magic-sparkles').addClass('fa-spinner fa-spin');
        try {
            const storyTxt = buildPassageFromRange(chat, rangeStart, rangeEnd);
            if (!storyTxt.trim()) { toastr.error('Source turns are empty — cannot audit.', 'Summaryception'); return; }
            const contextParts = [];
            for (let i = store.layers.length - 1; i >= 0; i--) {
                const l = store.layers[i];
                if (!l) continue;
                for (let k = 0; k < l.length; k++) {
                    if (i === layerIdx && k === snippetIdx) continue;
                    contextParts.push(l[k].text);
                }
            }
            const contextStr = contextParts.length > 0 ? contextParts.join(' ') : '(none yet)';
            toastr.info(`Auditing turns ${rangeStart}–${rangeEnd} for detail…`, 'Summaryception', { timeOut: 3000, progressBar: true });
            const detail = await callAuditor(storyTxt, sn.text, contextStr);
            if (detail) {
                sn.detail = detail;
                toastr.success('Detail generated', 'Summaryception', { timeOut: 2500 });
            } else {
                delete sn.detail;
                toastr.info('Auditor found nothing to add — the snippet already covers it.', 'Summaryception', { timeOut: 3000 });
            }
            await saveChatStore();
            updateInjection();
        } finally {
            isSummarizing = false;
            btn.prop('disabled', false).removeClass('fa-spinner fa-spin').addClass('fa-wand-magic-sparkles');
            updateSnippetBrowser();
        }
    });

    // Delete detail
    $('.sc-detail-delete').off('click').on('click', async function () {
        const layerIdx = parseInt($(this).closest('.sc-detail-row').data('layer'));
        const snippetIdx = parseInt($(this).closest('.sc-detail-row').data('idx'));
        const layer = store.layers[layerIdx];
        if (layer && layer[snippetIdx]) {
            delete layer[snippetIdx].detail;
            await saveChatStore();
            updateInjection();
            updateSnippetBrowser();
            toastr.info('Detail removed', 'Summaryception', { timeOut: 1500 });
        }
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ─── Continuity Editor ("Co-Writer / Master Novelist") ───────────────
// Reads the ENTIRE memory (notepad + all snippets + detail notes), asks a
// smart editor model for a MINIMAL set of edits to resolve a problem/retcon,
// then applies them under per-item review with a one-tap undo. Reuses the
// summarizer connection + machinery.

let _editorPending = [];
let _editorUndoSnapshot = null;
let _editorCancelled = false;

function buildMemoryDump() {
    const store = getChatStore();
    const snippets = [];
    if (store.layers) {
        for (let L = 0; L < store.layers.length; L++) {
            const layer = store.layers[L];
            if (!layer) continue;
            for (let i = 0; i < layer.length; i++) {
                const sn = layer[i];
                const entry = { id: `L${L}#${i}`, layer: L, text: sn.text };
                if (sn.turnRange) entry.turns = `${sn.turnRange[0]}-${sn.turnRange[1]}`;
                if (sn.detail) entry.detail = sn.detail;
                snippets.push(entry);
            }
        }
    }
    return { notepad: store.notepad || '', snippets };
}

function resolveSnippetId(id) {
    const m = /^L(\d+)#(\d+)$/.exec(String(id || '').trim());
    if (!m) return null;
    const layer = parseInt(m[1], 10), idx = parseInt(m[2], 10);
    const store = getChatStore();
    const arr = store.layers && store.layers[layer];
    if (!arr || !arr[idx]) return null;
    return { layer, idx, arr, obj: arr[idx] };
}

function extractJsonArray(raw) {
    if (!raw) return null;
    let t = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = t.indexOf('['), end = t.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start) return null;
    try { const p = JSON.parse(t.slice(start, end + 1)); return Array.isArray(p) ? p : null; }
    catch { return null; }
}

function recomputeSummarizedUpTo() {
    const store = getChatStore();
    const l0 = (store.layers && store.layers[0]) ? store.layers[0].filter(sn => sn.turnRange) : [];
    store.summarizedUpTo = l0.length > 0 ? Math.max(...l0.map(sn => sn.turnRange[1])) : -1;
}

function snapshotMemory() {
    const store = getChatStore();
    _editorUndoSnapshot = {
        notepad: store.notepad || '',
        layers: JSON.parse(JSON.stringify(store.layers || [])),
    };
}

async function restoreMemorySnapshot() {
    if (!_editorUndoSnapshot) return;
    const store = getChatStore();
    store.notepad = _editorUndoSnapshot.notepad;
    store.layers = JSON.parse(JSON.stringify(_editorUndoSnapshot.layers));
    recomputeSummarizedUpTo();
    await saveChatStore();
    updateInjection(true);
    updateUI();
    $('#sc_notepad').val(store.notepad || '');
    $('#sc_editor_undo').hide();
    $('#sc_editor_review_list').empty();
    _editorUndoSnapshot = null;
    _editorPending = [];
    toastr.success('Reverted — memory restored to before the edits.', 'Summaryception', { timeOut: 3000 });
}

async function runContinuityEditorReview() {
    const s = getSettings();
    const command = ($('#sc_editor_command').val() || '').trim();
    if (!command) { toastr.warning('Describe what to fix first.', 'Summaryception'); return; }
    const dump = buildMemoryDump();
    if (dump.snippets.length === 0 && !dump.notepad.trim()) {
        toastr.info('No memory yet to edit in this chat.', 'Summaryception'); return;
    }
    const btn = $('#sc_editor_review');
    btn.prop('disabled', true).text('Thinking…');
    _editorCancelled = false;
    $('#sc_editor_cancel').show();
    try {
        const memStr = JSON.stringify(dump, null, 1);
        const userTpl = (s.editorUserPrompt || '')
            .replace('{{command}}', command)
            .replace('{{memory}}', memStr)
            .replace('{{player_name}}', getPlayerName());
        toastr.info('Co-Writer is reviewing your full memory…', 'Summaryception', { timeOut: 4000, progressBar: true });
        const raw = await callSummarizer('(continuity edit)', '', {
            systemPrompt: s.editorSystemPrompt,
            userPrompt: userTpl,
        });
        if (_editorCancelled) {
            toastr.info('Review cancelled — nothing was changed.', 'Summaryception', { timeOut: 2500 });
            return;
        }
        const edits = extractJsonArray(raw);
        if (!edits) {
            toastr.error('Co-Writer did not return valid edits. Try rephrasing, or point the connection at a stronger model.', 'Summaryception', { timeOut: 7000 });
            return;
        }
        if (edits.length === 0) {
            $('#sc_editor_review_list').empty();
            toastr.info('Co-Writer found nothing that needs changing.', 'Summaryception', { timeOut: 5000 });
            return;
        }
        snapshotMemory();   // capture pre-edit state so every Apply can be undone
        renderEditorReview(edits);
    } catch (e) {
        log('Continuity editor error:', e);
        toastr.error('Co-Writer failed — nothing was changed.', 'Summaryception', { timeOut: 5000 });
    } finally {
        $('#sc_editor_cancel').hide();
        _editorCancelled = false;
        btn.prop('disabled', false).text('🔍 Review Proposed Edits');
    }
}

function renderEditorReview(edits) {
    _editorPending = [];
    let cards = '';
    let shown = 0;
    edits.forEach((e, i) => {
        const op = String(e.op || '');
        let head, kind, oldText;
        if (op === 'edit_notepad') {
            _editorPending[i] = { op };
            head = '✏️ Notepad (canon)'; kind = 'edit'; oldText = getChatStore().notepad || '';
        } else if (['edit_snippet', 'delete_snippet', 'edit_detail', 'delete_detail'].includes(op)) {
            const r = resolveSnippetId(e.id);
            if (!r) return;   // id doesn't exist — skip this edit
            _editorPending[i] = { op, ref: r };
            if (op === 'edit_snippet')       { head = `✏️ Snippet ${e.id}`;   kind = 'edit';   oldText = r.obj.text || ''; }
            else if (op === 'delete_snippet'){ head = `🗑️ Snippet ${e.id}`;   kind = 'delete'; oldText = r.obj.text || ''; }
            else if (op === 'edit_detail')   { head = `✏️ Detail on ${e.id}`; kind = 'edit';   oldText = r.obj.detail || ''; }
            else                             { head = `🗑️ Detail on ${e.id}`; kind = 'delete'; oldText = r.obj.detail || ''; }
        } else { return; }   // unknown op — skip
        shown++;
        const reason = e.reason ? `<div class="sc-editor-reason">${escapeHtml(String(e.reason))}</div>` : '';
        const oldBlock = `<div class="sc-editor-old">was: ${escapeHtml(oldText.slice(0, 240))}${oldText.length > 240 ? '…' : ''}</div>`;
        const body = kind === 'edit'
            ? oldBlock + `<textarea class="sc-editor-new text_pole" data-idx="${i}" rows="3">${escapeHtml(String(e.text || ''))}</textarea>`
            : oldBlock;
        cards += `<div class="sc-editor-card ${kind === 'delete' ? 'sc-editor-card-del' : ''}" data-idx="${i}">
            <div class="sc-editor-head">${head}</div>
            ${reason}
            ${body}
            <div class="sc-editor-btns">
                <button class="sc-editor-apply menu_button" data-idx="${i}">${kind === 'delete' ? 'Apply (delete)' : 'Apply'}</button>
                <button class="sc-editor-reject menu_button" data-idx="${i}">Reject</button>
            </div>
        </div>`;
    });
    const header = `<div class="sc-editor-actions"><button id="sc_editor_applyall" class="menu_button">✅ Apply All (${shown})</button></div>`;
    $('#sc_editor_review_list').html(shown ? header + cards : '<div class="sc-hint">No applicable edits — the proposed ids weren\'t found in memory.</div>');
}

async function applyEditorOp(i) {
    const pend = _editorPending[i];
    if (!pend) return false;
    const store = getChatStore();
    const card = $(`.sc-editor-card[data-idx="${i}"]`);
    const newVal = String(card.find('.sc-editor-new').val() ?? '').trim();
    if (pend.op === 'edit_notepad') {
        store.notepad = newVal;
        $('#sc_notepad').val(newVal);
    } else if (pend.ref) {
        const { obj, arr } = pend.ref;   // object reference — stable across splices
        if (pend.op === 'edit_snippet') { if (newVal) obj.text = newVal; }
        else if (pend.op === 'edit_detail') { if (newVal) obj.detail = newVal; else delete obj.detail; }
        else if (pend.op === 'delete_detail') { delete obj.detail; }
        else if (pend.op === 'delete_snippet') { const k = arr.indexOf(obj); if (k >= 0) arr.splice(k, 1); }
    }
    recomputeSummarizedUpTo();
    await saveChatStore();
    updateInjection(true);
    return true;
}

async function finalizeAfterApply() {
    updateUI();
    if (typeof updateSnippetBrowser === 'function') updateSnippetBrowser();
    $('#sc_editor_undo').show();
}

// ─── Copilot Bridge: mirror memory into the Author's Note ─────────────
// External OOC tools (e.g. ST-Copilot) can't read Summaryception's memory
// directly — they only read native fields. The Author's Note is the one native
// field that's meant to be written programmatically and that such tools read.
// So we can copy the FULL memory (notepad + snippets + details) into it on
// demand, and pull it back out — stashing any real Author's Note content in a
// non-injected place so nothing is lost or permanently duplicated.
const SC_AN_START = '[SUMMARYCEPTION MEMORY';
const SC_AN_END = '[END SUMMARYCEPTION MEMORY]';

function formatMemoryForAN() {
    const dump = buildMemoryDump();
    // Slim mirror: only the parts Copilot's native Summaryception integration does NOT
    // read. That integration already feeds Copilot the snippet TEXT automatically, but it
    // never reads the notepad or the detail notes — so we bridge exactly those two.
    let out = `${SC_AN_START} (canon + key details) — for OOC analysis tools. NOTE: the running event snippets are already provided to you separately via the Summaryception integration; this block adds only what that integration omits: permanent canon and the specifics behind key events. Treat as canon, NOT as roleplay direction.]\n\n`;
    out += `NOTEPAD (permanent canon — highest authority):\n${dump.notepad && dump.notepad.trim() ? dump.notepad.trim() : '(empty)'}\n\n`;
    const withDetails = dump.snippets.filter(s => s.detail);
    if (withDetails.length) {
        out += `KEY DETAILS (specifics attached to particular events; the event summaries themselves are already in your <summary_context>):\n`;
        for (const s of withDetails) {
            const turns = s.turns ? ` (turns ${s.turns})` : '';
            out += `- [${s.id}${turns}] ${s.text} — DETAIL: ${s.detail}\n`;
        }
    }
    out += `\n${SC_AN_END}`;
    return out;
}

function _getAuthorsNote() {
    const ctx = SillyTavern.getContext();
    return (ctx.chatMetadata && ctx.chatMetadata.note_prompt) || '';
}

function _setAuthorsNote(text) {
    const ctx = SillyTavern.getContext();
    if (ctx.chatMetadata) {
        ctx.chatMetadata.note_prompt = text;
        if (typeof ctx.saveMetadata === 'function') ctx.saveMetadata();
    }
    // keep the on-screen Author's Note textarea in sync if it's rendered
    const $an = $('#extension_floating_prompt');
    if ($an.length) { $an.val(text).trigger('input'); }
}

async function mirrorMemoryToAN() {
    const store = getChatStore();
    const current = _getAuthorsNote();
    // stash the REAL author's note (non-injected storage) only if it isn't already our block
    if (!current.includes(SC_AN_START)) {
        store.anStash = current;
        await saveChatStore();
    }
    _setAuthorsNote(formatMemoryForAN());
    toastr.success("Full memory mirrored to the Author's Note. Ask Copilot now — then hit Restore.", 'Summaryception', { timeOut: 5000 });
}

async function restoreAuthorsNoteFromStash() {
    const store = getChatStore();
    const stashed = store.anStash != null ? store.anStash : '';
    _setAuthorsNote(stashed);
    delete store.anStash;
    await saveChatStore();
    toastr.info(stashed.trim() ? "Author's Note restored." : "Author's Note cleared (nothing was there before).", 'Summaryception', { timeOut: 3000 });
}

async function clearAuthorsNoteHard() {
    const store = getChatStore();
    _setAuthorsNote('');
    delete store.anStash;
    await saveChatStore();
    toastr.info("Author's Note wiped.", 'Summaryception', { timeOut: 2500 });
}

function bindUIEvents() {
    $(document).on('change', '#sc_enabled', function () {
        getSettings().enabled = $(this).prop('checked');
        saveSettings();
        updateInjection();
    });

    $(document).on('change', '#sc_pause_summarization', function () {
        const s = getSettings();
        s.pauseSummarization = $(this).prop('checked');
        saveSettings();

        if (s.pauseSummarization) {
            toastr.info(
                'Summarization paused. Existing summaries will continue to be injected. Use Force Summarize or unpause to catch up.',
                'Summaryception',
                { timeOut: 5000 }
            );
        } else {
            toastr.info(
                'Summarization resumed. Will process new turns automatically.',
                'Summaryception',
                { timeOut: 3000 }
            );
        }
    });

    $(document).on('change', '#sc_disable_ghosting', function () {
        getSettings().disableGhosting = $(this).prop('checked');
        saveSettings();

        if ($(this).prop('checked')) {
            toastr.info(
                'Message hiding disabled. Summarized messages will remain visible but still be excluded from LLM context via the sc_ghosted flag.',
                'Summaryception',
                { timeOut: 5000 }
            );
        }
    });

    $(document).on('input', '#sc_summarizer_response_length', function () {
        getSettings().summarizerResponseLength = parseInt($(this).val(), 10) || 0;
        saveSettings();
    });

    $(document).on('change', '#sc_strip_patterns', function () {
        const lines = $(this).val().split('\n').map(l => l.trim()).filter(l => l.length > 0);
        getSettings().stripPatterns = lines;
        saveSettings();
    });

    const sliders = [
        { id: '#sc_verbatim_turns', key: 'verbatimTurns', display: '#sc_verbatim_turns_val' },
        { id: '#sc_turns_per_summary', key: 'turnsPerSummary', display: '#sc_turns_per_summary_val' },
        { id: '#sc_snippets_per_layer', key: 'snippetsPerLayer', display: '#sc_snippets_per_layer_val' },
        { id: '#sc_snippets_per_promotion', key: 'snippetsPerPromotion', display: '#sc_snippets_per_promotion_val' },
        { id: '#sc_max_layers', key: 'maxLayers', display: '#sc_max_layers_val' },
    ];

    for (const sl of sliders) {
        $(document).on('input', sl.id, function () {
            const val = parseInt($(this).val(), 10);
            getSettings()[sl.key] = val;
            $(sl.display).text(val);
            saveSettings();
            updateInjection();
        });
    }

    const textareas = [
        { id: '#sc_injection_template', key: 'injectionTemplate' },
        { id: '#sc_summarizer_system_prompt', key: 'summarizerSystemPrompt' },
    ];

    for (const ta of textareas) {
        $(document).on('change', ta.id, function () {
            getSettings()[ta.key] = $(this).val();
            saveSettings();
        });
    }

    // ── Injection placement controls ──
    $(document).on('change', '#sc_injection_position', function () {
        getSettings().injectionPosition = parseInt($(this).val(), 10);
        saveSettings();
        updateInjection(true);
    });
    $(document).on('input', '#sc_injection_depth', function () {
        const val = parseInt($(this).val(), 10);
        getSettings().injectionDepth = val;
        $('#sc_injection_depth_val').text(val);
        saveSettings();
        updateInjection(true);
    });

    // ── Manual notepad (per-chat, live) ──
    $(document).on('input', '#sc_notepad', function () {
        getChatStore().notepad = $(this).val();
        saveChatStore();
        updateInjection(true);
    });

    // ── Detail Auditor (sister) ──
    $(document).on('change', '#sc_sister_enabled', function () {
        getSettings().sisterEnabled = $(this).prop('checked');
        saveSettings();
        updateInjection(true);
    });
    $(document).on('input', '#sc_sister_system_prompt', function () {
        getSettings().sisterSystemPrompt = $(this).val();
        saveSettings();
    });
    $(document).on('input', '#sc_sister_user_prompt', function () {
        getSettings().sisterUserPrompt = $(this).val();
        saveSettings();
    });

    // ── Continuity Editor (Co-Writer / Master Novelist) ──
    $(document).on('click', '#sc_editor_review', runContinuityEditorReview);
    $(document).on('click', '#sc_editor_undo', restoreMemorySnapshot);
    $(document).on('click', '#sc_editor_cancel', function () {
        _editorCancelled = true;
        abortSummarization();
        toastr.info('Cancelling the co-writer…', 'Summaryception', { timeOut: 1500 });
    });

    // ── Copilot Bridge (Author's Note) ──
    $(document).on('click', '#sc_mirror_an', mirrorMemoryToAN);
    $(document).on('click', '#sc_restore_an', restoreAuthorsNoteFromStash);
    $(document).on('click', '#sc_clear_an', clearAuthorsNoteHard);
    $(document).on('input', '#sc_editor_system_prompt', function () {
        getSettings().editorSystemPrompt = $(this).val();
        saveSettings();
    });
    $(document).on('input', '#sc_editor_user_prompt', function () {
        getSettings().editorUserPrompt = $(this).val();
        saveSettings();
    });
    $(document).on('click', '.sc-editor-apply', async function () {
        const i = parseInt($(this).data('idx'), 10);
        const ok = await applyEditorOp(i);
        if (ok) {
            $(`.sc-editor-card[data-idx="${i}"]`).slideUp(120, function () { $(this).remove(); });
            await finalizeAfterApply();
            toastr.success('Applied', 'Summaryception', { timeOut: 1200 });
        }
    });
    $(document).on('click', '.sc-editor-reject', function () {
        const i = parseInt($(this).data('idx'), 10);
        $(`.sc-editor-card[data-idx="${i}"]`).slideUp(120, function () { $(this).remove(); });
    });
    $(document).on('click', '#sc_editor_applyall', async function () {
        const btn = $(this);
        btn.prop('disabled', true).text('Applying…');
        const order = [];
        _editorPending.forEach((p, i) => { if (p) order.push(i); });
        // apply deletes last (object refs keep this safe; this is just tidy ordering)
        order.sort((a, b) => (/^delete_/.test((_editorPending[a] || {}).op) ? 1 : 0) - (/^delete_/.test((_editorPending[b] || {}).op) ? 1 : 0));
        let n = 0;
        for (const i of order) {
            if ($(`.sc-editor-card[data-idx="${i}"]`).length === 0) continue;   // skip rejected
            const ok = await applyEditorOp(i);
            if (ok) n++;
        }
        await finalizeAfterApply();
        $('#sc_editor_review_list').empty();
        toastr.success(`Applied ${n} edit(s)`, 'Summaryception', { timeOut: 2500 });
        btn.prop('disabled', false).text('✅ Apply All');
    });

    $(document).on('change', '#sc_debug_mode', function () {
        getSettings().debugMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('change', '#sc_trace_mode', function () {
        getSettings().traceMode = $(this).prop('checked');
        saveSettings();
    });

    $(document).on('click', '#sc_repair', async function () {
        const { chat } = SillyTavern.getContext();
        let repaired = 0;

        const progressToast = toastr.info(
            'Scanning for orphaned messages...',
            'Summaryception — Repair',
            { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }
        );

        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];

            const isStuckHidden = (m.is_system || m.is_hidden)
            && !m.is_user
            && !m.extra?.sc_ghosted
            && m.mes
            && m.mes.trim().length > 0;

            if (isStuckHidden) {
                try {
                    await SillyTavern.getContext().executeSlashCommandsWithOptions(`/unhide ${i}`, { showOutput: false });
                } catch (e) {
                    log(`Repair: failed to unhide ${i}:`, e);
                }

                m.is_system = false;
                delete m.is_hidden;

                repaired++;

                if (repaired % 5 === 0) {
                    $(progressToast).find('.toast-message').text(
                        `Repairing: found ${repaired} orphaned messages...`
                    );
                }
            }
        }

        toastr.clear(progressToast);

        if (repaired > 0) {
            try {
                const ctx = SillyTavern.getContext();
                if (ctx.saveChat) await ctx.saveChat();
            } catch (e) {
                log('Could not save chat:', e);
            }
            updateUI();
            toastr.success(
                `Repaired ${repaired} orphaned messages. They are now visible to the summarizer again.`,
                'Summaryception',
                { timeOut: 5000 }
            );
        } else {
            toastr.info('No orphaned messages found.', 'Summaryception', { timeOut: 3000 });
        }
    });

    $(document).on('click', '#sc_clear_memory', async function () {
        if (!confirm('Clear ALL Summaryception memory for this chat and unghost all messages?')) return;

        try {
            await unghostAllMessages();
        } catch (e) {
            console.error(LOG_PREFIX, 'Error during unghost (continuing with clear):', e);
            toastr.warning('Some messages could not be unghosted, but memory will still be cleared.', 'Summaryception');
        }

        const store = getChatStore();
        store.layers.length = 0;
        store.summarizedUpTo = -1;
        store.ghostedIndices = [];

        const { chatMetadata } = SillyTavern.getContext();
        chatMetadata[MODULE_NAME] = store;

        await saveChatStore();
        try {
            const ctx = SillyTavern.getContext();
            if (ctx.saveChat) await ctx.saveChat();
        } catch (e) {
            log('Could not save chat:', e);
        }
        updateInjection();
        updateUI();
        toastr.success('Memory cleared & messages unghosted', 'Summaryception');
    });

    $(document).on('click', '#sc_force_summarize', async function () {
        const s = getSettings();
        if (!s.enabled) {
            toastr.warning('Enable Summaryception first.');
            return;
        }
        if (isSummarizing) {
            toastr.warning('Already summarizing. Please wait.');
            return;
        }
        if (s.pauseSummarization) {
            log('Force Summarize overrides pause mode.');
        }
        $(this).prop('disabled', true).text(' Working…');
        try {
            catchupDismissed = false;

            const { chat } = SillyTavern.getContext();
            const allAssistantTurns = getAssistantTurns(chat);
            const visibleTurns = allAssistantTurns.filter(t => !chat[t.index].extra?.sc_ghosted);

            if (visibleTurns.length <= s.verbatimTurns) {
                toastr.info('Nothing to summarize — visible turns are within the verbatim limit.', 'Summaryception');
                return;
            }

            const overflow = visibleTurns.length - s.verbatimTurns;
            toastr.info(`${overflow} turns to process. Starting...`, 'Summaryception', { timeOut: 2000 });

            await runCatchup(visibleTurns, overflow);
            updateInjection();
        } finally {
            $(this).prop('disabled', false).html('<i class="fa-solid fa-bolt"></i> Force Summarize Now');
            updateUI();
        }
    });

    $(document).on('click', '#sc_stop_summarize', function () {
        if (!isSummarizing && !currentAbortController) {
            toastr.info('Nothing is running.', 'Summaryception');
            return;
        }
        abortSummarization();
        toastr.warning('Summarization stopped. Progress has been saved.', 'Summaryception', { timeOut: 4000 });
        $(this).prop('disabled', true);
        setTimeout(() => $(this).prop('disabled', false), 2000);
        updateUI();
    });

    $(document).on('click', '#sc_refresh_preview', () => updateUI());

    $(document).on('click', '#sc_export', function () {
        const store = getChatStore();
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Memory exported', 'Summaryception');
    });

    $(document).on('click', '#sc_import', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data.layers || !Array.isArray(data.layers)) {
                    toastr.error('Invalid file format.');
                    return;
                }

                const { chat } = SillyTavern.getContext();
                const store = getChatStore();

                await unghostAllMessages();

                store.layers = data.layers;
                store.summarizedUpTo = data.summarizedUpTo ?? -1;
                store.ghostedIndices = data.ghostedIndices || [];

                if (store.summarizedUpTo >= 0) {
                    await ghostMessagesUpTo(store.summarizedUpTo);
                }

                await saveChatStore();
                try {
                    const ctx = SillyTavern.getContext();
                    if (ctx.saveChat) await ctx.saveChat();
                } catch (e) {
                    log('Could not save chat:', e);
                }
                updateInjection();
                updateUI();
                toastr.success(
                    `Memory imported. ${store.layers.reduce((sum, l) => sum + (l?.length || 0), 0)} snippets loaded, messages ghosted up to index ${store.summarizedUpTo}.`,
                               'Summaryception',
                               { timeOut: 4000 }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.');
            }
        };
        input.click();
    });

    // ── Prompt Preset dropdown ──
    $(document).on('change', '#sc_prompt_preset', function () {
        const selected = $(this).val();
        const s = getSettings();
        const previousPreset = s.promptPreset;

        // Auto-save custom prompt before switching away
        if (previousPreset === 'custom') {
            s.lastCustomPrompt = s.summarizerUserPrompt || '';
            log('Auto-saved custom prompt before switching to', selected);
        }

        s.promptPreset = selected;

        if (selected === 'custom') {
            // Restore the last custom prompt if we have one
            if (s.lastCustomPrompt) {
                $('#sc_summarizer_user_prompt').val(s.lastCustomPrompt);
                s.summarizerUserPrompt = s.lastCustomPrompt;
                log('Restored auto-saved custom prompt');
            }
            $('#sc_custom_prompt_manager').show();
        } else {
            const presetText = PROMPT_PRESETS[selected];
            $('#sc_summarizer_user_prompt').val(presetText);
            s.summarizerUserPrompt = presetText;
            $('#sc_custom_prompt_manager').hide();
        }

        saveSettings();
        updateCustomPromptSlots();
    });

    // Auto-switch to 'custom' when user manually edits the prompt textarea
    $(document).on('input', '#sc_summarizer_user_prompt', function () {
        const currentText = $(this).val();
        const s = getSettings();

        s.summarizerUserPrompt = currentText;

        if (s.promptPreset !== 'custom') {
            const presetText = PROMPT_PRESETS[s.promptPreset];
            if (currentText !== presetText) {
                // Auto-save before we switch to custom
                s.promptPreset = 'custom';
                s.lastCustomPrompt = currentText;
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                updateCustomPromptSlots();
            }
        } else {
            // Keep lastCustomPrompt in sync while editing in custom mode
            s.lastCustomPrompt = currentText;
        }

        saveSettings();
    });

    // ── Custom Prompt: Save to named slot ──
    $(document).on('click', '#sc_custom_prompt_save', function () {
        const name = $('#sc_custom_prompt_name').val().trim();
        if (!name) {
            toastr.warning('Enter a name for the prompt.', 'Summaryception');
            return;
        }

        const s = getSettings();
        if (!s.savedCustomPrompts) s.savedCustomPrompts = {};

        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to save.', 'Summaryception');
            return;
        }

        const isOverwrite = s.savedCustomPrompts[name];
        s.savedCustomPrompts[name] = promptText;
        saveSettings();

        $('#sc_custom_prompt_name').val('');
        updateCustomPromptSlots();

        toastr.success(
            `Prompt "${name}" ${isOverwrite ? 'updated' : 'saved'}.`,
            'Summaryception',
            { timeOut: 2000 }
        );
    });

    // ── Custom Prompt: Load from named slot ──
    $(document).on('click', '#sc_custom_prompt_load', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to load.', 'Summaryception');
            return;
        }

        const s = getSettings();
        const promptText = s.savedCustomPrompts?.[name];
        if (!promptText) {
            toastr.error(`Prompt "${name}" not found.`, 'Summaryception');
            return;
        }

        $('#sc_summarizer_user_prompt').val(promptText);
        s.summarizerUserPrompt = promptText;
        s.lastCustomPrompt = promptText;
        s.promptPreset = 'custom';
        $('#sc_prompt_preset').val('custom');
        saveSettings();

        toastr.success(`Loaded prompt "${name}".`, 'Summaryception', { timeOut: 2000 });
    });

    // ── Custom Prompt: Delete named slot ──
    $(document).on('click', '#sc_custom_prompt_delete_slot', function () {
        const name = $('#sc_custom_prompt_slot').val();
        if (!name) {
            toastr.warning('Select a saved prompt to delete.', 'Summaryception');
            return;
        }

        if (!confirm(`Delete saved prompt "${name}"?`)) return;

        const s = getSettings();
        if (s.savedCustomPrompts) {
            delete s.savedCustomPrompts[name];
            saveSettings();
        }

        updateCustomPromptSlots();
        toastr.info(`Prompt "${name}" deleted.`, 'Summaryception', { timeOut: 2000 });
    });

    // ── Custom Prompt: Export as .txt ──
    $(document).on('click', '#sc_custom_prompt_export', function () {
        const promptText = $('#sc_summarizer_user_prompt').val();
        if (!promptText.trim()) {
            toastr.warning('Prompt is empty — nothing to export.', 'Summaryception');
            return;
        }

        const blob = new Blob([promptText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `summaryception_prompt_${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        toastr.success('Prompt exported.', 'Summaryception', { timeOut: 2000 });
    });

    // ── Custom Prompt: Import from .txt ──
    $(document).on('click', '#sc_custom_prompt_import', function () {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.txt,.text';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                if (!text.trim()) {
                    toastr.warning('File is empty.', 'Summaryception');
                    return;
                }

                const s = getSettings();
                $('#sc_summarizer_user_prompt').val(text);
                s.summarizerUserPrompt = text;
                s.lastCustomPrompt = text;
                s.promptPreset = 'custom';
                $('#sc_prompt_preset').val('custom');
                $('#sc_custom_prompt_manager').show();
                saveSettings();
                updateCustomPromptSlots();

                toastr.success(
                    `Prompt imported from "${file.name}".`,
                    'Summaryception',
                    { timeOut: 3000 }
                );
            } catch (err) {
                console.error(LOG_PREFIX, err);
                toastr.error('Import failed — check console.', 'Summaryception');
            }
        };
        input.click();
    });

    $(document).on('click', '#sc_reset_defaults', function () {
        if (!confirm(
            'Reset all Advanced Settings to defaults?\n\n' +
            'This will reset sliders, prompts, injection template, and strip patterns.\n' +
            'It will NOT clear your summary memory or connection settings.'
        )) return;

        const s = getSettings();

        // Reset sliders
        s.verbatimTurns = defaultSettings.verbatimTurns;
        s.turnsPerSummary = defaultSettings.turnsPerSummary;
        s.snippetsPerLayer = defaultSettings.snippetsPerLayer;
        s.snippetsPerPromotion = defaultSettings.snippetsPerPromotion;
        s.maxLayers = defaultSettings.maxLayers;

        // Reset prompts
        s.summarizerSystemPrompt = defaultSettings.summarizerSystemPrompt;
        s.summarizerUserPrompt = defaultSettings.summarizerUserPrompt;
        s.promptPreset = defaultSettings.promptPreset;
        s.injectionTemplate = defaultSettings.injectionTemplate;
        s.stripPatterns = [...defaultSettings.stripPatterns];
        s.summarizerResponseLength = defaultSettings.summarizerResponseLength;

        // Reset debug
        s.debugMode = defaultSettings.debugMode;
        s.traceMode = defaultSettings.traceMode;

        saveSettings();
        updateInjection();
        updateUI();

        toastr.success(
            'Advanced settings reset to defaults. Connection settings and summary memory were preserved.',
            'Summaryception',
            { timeOut: 4000 }
        );
    });
}

// ─── Connection Settings UI ──────────────────────────────────────────

function initConnectionUI() {
    const s = () => getSettings();
    const save = () => saveSettings();

    // ── Source dropdown ──
    const sourceSelect = document.getElementById('summaryception_connection_source');
    if (sourceSelect) {
        sourceSelect.value = s().connectionSource || 'default';
        sourceSelect.addEventListener('change', () => {
            s().connectionSource = sourceSelect.value;
            save();
            updateConnectionSubPanels(sourceSelect.value);
        });
    }

    // ── Connection Profile dropdown ──
    const profileSelect = document.getElementById('summaryception_connection_profile');
    if (profileSelect) {
        const populated = populateProfileDropdown(profileSelect, s().connectionProfileId);
        if (!populated) {
            fetchProfilesFallback(profileSelect, s().connectionProfileId);
        }
        profileSelect.addEventListener('change', () => {
            s().connectionProfileId = profileSelect.value;
            save();
        });
    }

    // ── Ollama URL ──
    const ollamaUrl = document.getElementById('summaryception_ollama_url');
    if (ollamaUrl) {
        ollamaUrl.value = s().ollamaUrl || 'http://localhost:11434';
        ollamaUrl.addEventListener('input', () => {
            s().ollamaUrl = ollamaUrl.value.trim();
            save();
        });
    }

    // ── Ollama Model dropdown ──
    const ollamaModel = document.getElementById('summaryception_ollama_model');
    if (ollamaModel) {
        populateOllamaModelDropdown(ollamaModel, s().ollamaModelsCache || [], s().ollamaModel);
        ollamaModel.addEventListener('change', () => {
            s().ollamaModel = ollamaModel.value;
            save();
        });
    }

    // ── Ollama Refresh button ──
    const ollamaRefresh = document.getElementById('summaryception_ollama_refresh');
    if (ollamaRefresh) {
        ollamaRefresh.addEventListener('click', async () => {
            await refreshOllamaModels();
        });
    }

    // ── OpenAI URL ──
    const openaiUrl = document.getElementById('summaryception_openai_url');
    if (openaiUrl) {
        openaiUrl.value = s().openaiUrl || '';
        openaiUrl.addEventListener('input', () => {
            s().openaiUrl = openaiUrl.value.trim();
            save();
        });
    }

    // ── OpenAI Key ──
    const openaiKey = document.getElementById('summaryception_openai_key');
    if (openaiKey) {
        openaiKey.value = s().openaiKey || '';
        openaiKey.addEventListener('input', () => {
            s().openaiKey = openaiKey.value.trim();
            save();
        });
    }

    // ── OpenAI Model ──
    const openaiModel = document.getElementById('summaryception_openai_model');
    if (openaiModel) {
        openaiModel.value = s().openaiModel || '';
        openaiModel.addEventListener('input', () => {
            s().openaiModel = openaiModel.value.trim();
            save();
        });
    }

    // ── OpenAI Max Tokens ──
    const openaiMaxTokens = document.getElementById('summaryception_openai_max_tokens');
    if (openaiMaxTokens) {
        openaiMaxTokens.value = s().openaiMaxTokens || 0;
        openaiMaxTokens.addEventListener('input', () => {
            s().openaiMaxTokens = parseInt(openaiMaxTokens.value, 10) || 0;
            save();
        });
    }

    // ── OpenAI Test button ──
    const openaiTest = document.getElementById('summaryception_openai_test');
    if (openaiTest) {
        openaiTest.addEventListener('click', async () => {
            await testOpenAIConnectionHandler();
        });
    }

    // Set initial visibility
    updateConnectionSubPanels(s().connectionSource || 'default');
}

function updateConnectionSubPanels(source) {
    const panels = {
        profile: document.getElementById('summaryception_profile_settings'),
        ollama: document.getElementById('summaryception_ollama_settings'),
        openai: document.getElementById('summaryception_openai_settings'),
    };

    Object.values(panels).forEach(panel => {
        if (panel) panel.style.display = 'none';
    });

    if (panels[source]) {
        panels[source].style.display = 'block';
    }
}

function populateOllamaModelDropdown(selectElement, models, currentValue) {
    selectElement.innerHTML = '<option value="">-- Select Model --</option>';

    if (models && models.length > 0) {
        for (const model of models) {
            const opt = document.createElement('option');
            opt.value = model.name || model;
            opt.textContent = model.name || model;
            selectElement.appendChild(opt);
        }
    }

    if (currentValue) {
        selectElement.value = currentValue;
    }
}

async function refreshOllamaModels() {
    const s = getSettings();
    const ollamaUrl = s.ollamaUrl || 'http://localhost:11434';
    const modelSelect = document.getElementById('summaryception_ollama_model');

    showConnectionStatus('loading', 'Fetching Ollama models...');

    try {
        const models = await fetchOllamaModels(ollamaUrl);
        s.ollamaModelsCache = models.map(m => ({ name: m.name }));
        saveSettings();

        if (modelSelect) {
            populateOllamaModelDropdown(modelSelect, models, s.ollamaModel);
        }

        showConnectionStatus('success', `Found ${models.length} model(s)`);
        toastr.success(`Found ${models.length} Ollama model(s)`, 'Summaryception');
    } catch (error) {
        console.error('[Summaryception] Failed to fetch Ollama models:', error);
        showConnectionStatus('error', `Failed: ${error.message}`);
        toastr.error(`Failed to fetch Ollama models: ${error.message}`, 'Summaryception');
    }
}

async function testOpenAIConnectionHandler() {
    const s = getSettings();

    if (!s.openaiUrl) {
        toastr.warning('Please enter an endpoint URL first.', 'Summaryception');
        return;
    }
    if (!s.openaiModel) {
        toastr.warning('Please enter a model name first.', 'Summaryception');
        return;
    }

    showConnectionStatus('loading', 'Testing connection...');

    const result = await testOpenAIConnection(s.openaiUrl, s.openaiKey, s.openaiModel);

    if (result.success) {
        showConnectionStatus('success', result.message);
        toastr.success(result.message, 'Summaryception');
    } else {
        showConnectionStatus('error', result.message);
        toastr.error(result.message, 'Summaryception');
    }
}

function showConnectionStatus(type, message) {
    const container = document.getElementById('summaryception_connection_status');
    const icon = document.getElementById('summaryception_connection_status_icon');
    const text = document.getElementById('summaryception_connection_status_text');

    if (!container || !icon || !text) return;

    container.style.display = 'flex';
    container.className = 'summaryception-connection-status ' + type;

    const icons = {
        success: 'fa-solid fa-circle-check',
        error: 'fa-solid fa-circle-xmark',
        loading: 'fa-solid fa-spinner fa-spin',
    };

    icon.className = icons[type] || 'fa-solid fa-circle';
    text.textContent = message;

    if (type !== 'loading') {
        setTimeout(() => {
            if (container) container.style.display = 'none';
        }, 8000);
    }
}

async function fetchProfilesFallback(selectElement, currentValue) {
    try {
        const response = await fetch('/api/connection-manager/profiles', {
            method: 'GET',
            headers: SillyTavern.getContext().getRequestHeaders?.() || {
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            console.warn('[Summaryception] Could not fetch connection profiles from API');
            return;
        }

        const profiles = await response.json();

        selectElement.innerHTML = '<option value="">-- Select a Profile --</option>';

        if (Array.isArray(profiles)) {
            for (const profile of profiles) {
                const opt = document.createElement('option');
                opt.value = profile.id || profile.name;
                opt.textContent = profile.name || profile.id;
                selectElement.appendChild(opt);
            }
        } else if (typeof profiles === 'object') {
            for (const [id, profile] of Object.entries(profiles)) {
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = profile.name || id;
                selectElement.appendChild(opt);
            }
        }

        if (currentValue) {
            selectElement.value = currentValue;
        }
    } catch (error) {
        console.warn('[Summaryception] Could not fetch connection profiles:', error);
    }
}

// ─── Initialization ──────────────────────────────────────────────────

(async function init() {
    try {
        const {
            eventSource,
            event_types,
            renderExtensionTemplateAsync,
        } = SillyTavern.getContext();

        getSettings();

        // Register core hooks + slash commands FIRST. These are what actually run
        // your memory: injection, summarization, and branch repair. They don't
        // depend on the settings panel, so registering them up front means a panel
        // failure below can never stop them — and there's no window at startup
        // where an early chat event is missed.
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
        registerSlashCommands();

        eventSource.on(event_types.APP_READY, () => {
            updateInjection();
            updateUI();
            console.log(LOG_PREFIX, 'v5.8.2 (LO) loaded — background auditor (fast summarize+ghost).');
        });

        // Settings panel — isolated. renderExtensionTemplateAsync() fetches
        // settings.html by a FIXED path, so if this extension's folder is named
        // anything other than "Extension-Summaryception" the fetch 404s. Keeping
        // it in its own try means that failure only hides the settings panel;
        // the memory engine above keeps working.
        try {
            // Work out our OWN folder name from this module's URL, so the settings
            // panel loads no matter what you named the repo/folder. This removes the
            // fixed-name requirement entirely. If URL detection ever fails, fall back
            // to the current known folder name.
            let extPath = 'third-party/Summaryception-Personal-Bruce-';
            try {
                const m = import.meta.url.match(/extensions\/(third-party\/[^/]+)\//);
                if (m && m[1]) extPath = decodeURIComponent(m[1]);
            } catch (_) { /* keep fallback */ }

            const html = await renderExtensionTemplateAsync(extPath, 'settings', {});
            $('#extensions_settings2').append(html);
            bindUIEvents();
            initConnectionUI();
        } catch (e) {
            console.error(
                `${LOG_PREFIX} Settings panel failed to load (the core memory features still work). It tried to load settings from the extension's own folder, detected via import.meta.url.`,
                e
            );
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Initialization failed:`, e);
    }
})();
