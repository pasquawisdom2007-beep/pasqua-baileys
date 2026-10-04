/**
 * PASQUA GHOST MODE — invisibility cloak for WhatsApp sessions.
 *
 * When enabled, the session becomes literally *unwatchable*:
 *   • Never broadcasts "online" presence (no presence/chatstate stanzas out)
 *   • Never sends read receipts (blue ticks) — silently consumed
 *   • Never sends delivery receipts
 *   • Never shows typing / recording indicators
 *   • Suppresses the automatic "available" presence on reconnect
 *
 * ...while still RECEIVING everyone else's presence in real-time via the
 * normal `presence.update` event. You see them; nobody sees you.
 *
 * Usage:
 *   import { enableGhostMode, disableGhostMode, isGhostMode } from '@pasqua-baileys/baileys'
 *
 *   const ghost = enableGhostMode(sock)   // returns control handle
 *   // ...session is now invisible...
 *   ghost.off()                           // or disableGhostMode(sock)
 *   isGhostMode(sock)                     // => true
 *
 * Or declaratively at connect time:
 *   makeWASocket({ ghostMode: true })
 *
 * If you use or copy this code, please credit @pasqua-baileys/baileys.
 */

const GHOST_KEY = '__pasquaGhostMode';

/**
 * Internal interception state held on the socket.
 */
function ghostState(sock) {
    return sock[GHOST_KEY] || null;
}

/**
 * Enable ghost mode on a socket. Idempotent — re-enabling returns the
 * existing handle without double-hooking.
 */
export const enableGhostMode = (sock) => {
    if (!sock || typeof sock !== 'object') {
        throw new Error('enableGhostMode: a valid WASocket instance is required');
    }
    const existing = ghostState(sock);
    if (existing && existing.enabled) {
        return existing.handle;
    }

    // ── Intercept outbound presence/chatstate stanzas ────────────────────
    const originalSendNode = sock.sendNode ? sock.sendNode.bind(sock) : null;
    const blockedTypes = new Set(['presence', 'chatstate']);

    if (originalSendNode) {
        sock.sendNode = (node) => {
            if (node && blockedTypes.has(node.tag) && ghostState(sock)?.enabled) {
                sock.logger?.debug?.({ tag: node.tag }, '[ghost-mode] blocked outbound presence stanza');
                return Promise.resolve(true);
            }
            return originalSendNode(node);
        };
    }

    // ── Intercept outbound read/delivery receipts ────────────────────────
    const originalSendReceipt = sock.sendReceipt ? sock.sendReceipt.bind(sock) : null;
    if (originalSendReceipt) {
        sock.sendReceipt = async (...args) => {
            if (ghostState(sock)?.enabled) {
                sock.logger?.debug?.({ args }, '[ghost-mode] suppressed read/delivery receipt');
                return; // silently drop — no receipt ever leaves the session
            }
            return originalSendReceipt(...args);
        };
    }

    // ── Force offline presence at connect, suppress reconnect "available" ──
    const suppressAvailable = () => {
        if (ghostState(sock)?.enabled) {
            try {
                sock.sendPresenceUpdate?.('unavailable');
            }
            catch {
                // ignore — presence may not be ready yet
            }
        }
    };

    const connListener = (update) => {
        if (update.isOnline === true && ghostState(sock)?.enabled) {
            sock.logger?.debug?.({}, '[ghost-mode] suppressed isOnline broadcast');
            // re-emit as offline so host apps don't get confused
            try {
                sock.ev?.emit('connection.update', { isOnline: false });
            }
            catch {
                // ignore
            }
        }
    };
    sock.ev?.on('connection.update', connListener);

    const handle = {
        enabled: true,
        /** Temporarily reveal the session (send one presence update) */
        peek: () => {
            if (!ghostState(sock)?.enabled) return;
            ghostState(sock).enabled = false;
            try {
                sock.sendPresenceUpdate?.('available');
            }
            catch {
                // ignore
            }
            ghostState(sock).enabled = true;
            sock.logger?.debug?.({}, '[ghost-mode] peek sent');
        },
        /** Disable ghost mode (turn visibility back on) */
        off: () => disableGhostMode(sock)
    };

    sock[GHOST_KEY] = { enabled: true, handle, connListener, originalSendNode, originalSendReceipt };
    suppressAvailable();
    sock.logger?.info?.({}, '[ghost-mode] ENABLED — session is now invisible');
    return handle;
};

/**
 * Disable ghost mode and restore original sendNode/sendReceipt behavior.
 */
export const disableGhostMode = (sock) => {
    const state = ghostState(sock);
    if (!state) return false;
    if (state.originalSendNode) {
        sock.sendNode = state.originalSendNode;
    }
    if (state.originalSendReceipt) {
        sock.sendReceipt = state.originalSendReceipt;
    }
    if (state.connListener) {
        sock.ev?.off('connection.update', state.connListener);
    }
    delete sock[GHOST_KEY];
    sock.logger?.info?.({}, '[ghost-mode] DISABLED — session visibility restored');
    return true;
};

/**
 * Check whether ghost mode is currently active on a socket.
 */
export const isGhostMode = (sock) => !!ghostState(sock)?.enabled;
