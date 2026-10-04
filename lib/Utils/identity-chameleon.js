/**
 * PASQUA IDENTITY CHAMELEON — real-time identity mirroring engine.
 *
 * Clones any target contact's digital identity into the session:
 *   • Profile name (display name)
 *   • Profile picture / avatar (downloaded and re-uploaded)
 *   • About / status text
 *
 * Modes:
 *   'once'    — mirror once and stop
 *   'track'   — keep watching; when the target updates their identity, the
 *               session automatically re-syncs (live chameleon)
 *
 * Usage:
 *   import { createChameleon } from '@pasqua-baileys/baileys'
 *
 *   const chameleon = createChameleon(sock, '1234567890@s.whatsapp.net', {
 *       mode: 'track',
 *       onMirror: (field) => console.log('mirrored', field)
 *   })
 *
 *   await chameleon.mirror()      // mirror now
 *   chameleon.stop()              // stop tracking
 *   chameleon.snapshot()          // { name, about, pictureUrl } cache
 *
 * If you use or copy this code, please credit @pasqua-baileys/baileys.
 */
import { jidNormalizedUser, isPnUser, isLidUser } from '../WABinary/index.js';

export const CHAMELEON_MODES = ['once', 'track'];

/**
 * Create a chameleon instance bound to a socket and a target JID.
 */
export const createChameleon = (sock, targetJid, options = {}) => {
    if (!sock) throw new Error('createChameleon: socket is required');
    const target = jidNormalizedUser(targetJid);
    if (!isPnUser(target) && !isLidUser(target)) {
        throw new Error('createChameleon: target must be a user JID');
    }
    const { mode = 'once', onMirror, logger } = {
        mode: 'once',
        logger: sock.logger,
        ...options
    };
    if (!CHAMELEON_MODES.includes(mode)) {
        throw new Error(`createChameleon: mode must be one of ${CHAMELEON_MODES.join(', ')}`);
    }

    // Cache of the last mirrored identity snapshot
    const snapshot = { name: null, about: null, pictureUrl: null, mirroredAt: null };

    const log = (msg) => logger?.info?.({}, `[chameleon] ${msg}`);

    /** Fetch the target's current identity fields (best-effort). */
    const fetchIdentity = async () => {
        const [name, about, pictureUrl] = await Promise.allSettled([
            (async () => {
                try {
                    const contacts = await sock.onWhatsApp(target);
                    return contacts?.[0]?.name || contacts?.[0]?.notify || null;
                }
                catch {
                    return null;
                }
            })(),
            (async () => {
                try {
                    // getStatus is not exposed on all builds; try the fetch path
                    if (typeof sock.fetchStatus === 'function') {
                        const s = await sock.fetchStatus(target);
                        return s?.status || null;
                    }
                    return null;
                }
                catch {
                    return null;
                }
            })(),
            (async () => {
                try {
                    return await sock.profilePictureUrl(target, 'image');
                }
                catch {
                    return null;
                }
            })()
        ]);
        return {
            name: name.status === 'fulfilled' ? name.value : null,
            about: about.status === 'fulfilled' ? about.value : null,
            pictureUrl: pictureUrl.status === 'fulfilled' ? pictureUrl.value : null
        };
    };

    /** Apply a single mirrored field to the session's own identity. */
    const applyMirror = async (field, value) => {
        if (!value) return;
        try {
            switch (field) {
                case 'name':
                    if (typeof sock.updateProfileName === 'function') {
                        await sock.updateProfileName(String(value));
                        log(`profile name mirrored from ${target}`);
                    }
                    break;
                case 'about':
                    if (typeof sock.updateProfileStatus === 'function') {
                        await sock.updateProfileStatus(String(value));
                        log(`about/status mirrored from ${target}`);
                    }
                    break;
                case 'picture': {
                    if (typeof sock.updateProfilePicture === 'function' && value) {
                        const resp = await fetch(value);
                        const buffer = Buffer.from(await resp.arrayBuffer());
                        await sock.updateProfilePicture(sock.user?.id || target, buffer);
                        log(`avatar mirrored from ${target}`);
                    }
                    break;
                }
            }
            onMirror?.(field);
        }
        catch (err) {
            log(`failed to mirror ${field}: ${err.message}`);
        }
    };

    /** Perform one full mirror pass. */
    const mirror = async () => {
        const identity = await fetchIdentity();
        await applyMirror('name', identity.name);
        await applyMirror('about', identity.about);
        await applyMirror('picture', identity.pictureUrl);
        snapshot.name = identity.name;
        snapshot.about = identity.about;
        snapshot.pictureUrl = identity.pictureUrl;
        snapshot.mirroredAt = Date.now();
        return { ...snapshot };
    };

    // ── Track mode: re-mirror whenever presence updates arrive ───────────
    const presenceListener = (update) => {
        const id = update?.id;
        if (mode === 'track' && running && id === target && update.presences?.[target]) {
            // Presence change is a heuristic that the target was recently
            // active — good moment to re-pull identity fields.
            void mirror().catch((err) => log(`tracking mirror failed: ${err.message}`));
        }
    };
    let running = false;

    if (mode === 'track') {
        sock.ev?.on('presence.update', presenceListener);
        running = true;
        log(`tracking started for ${target}`);
    }

    return {
        target,
        mode,
        snapshot: () => ({ ...snapshot }),
        mirror,
        /** Stop tracking (no-op in 'once' mode) */
        stop: () => {
            running = false;
            if (mode === 'track') {
                sock.ev?.off('presence.update', presenceListener);
                log('tracking stopped');
            }
        }
    };
};
