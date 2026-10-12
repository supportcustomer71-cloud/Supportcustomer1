import { cert, getApps, initializeApp } from 'firebase-admin/app';
import type { App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

/**
 * FCM wake-on-offline.
 *
 * When a device transitions to offline, the server sends a single high-priority
 * data message to its FCM token. High-priority FCM messages are exempt from
 * Doze and App Standby, so this can wake a frozen/killed process — something no
 * in-app alarm can guarantee on every OEM.
 *
 * The feature is optional: without FIREBASE_SERVICE_ACCOUNT_BASE64 (or
 * ..._JSON) it stays disabled and the server behaves exactly as before.
 *
 * Requires only OUTBOUND https to Google (works on any VPS, e.g. Coolify).
 */

export type WakeResult = 'ok' | 'unregistered' | 'error' | 'disabled';

interface ServiceAccountShape {
    projectId: string;
    clientEmail: string;
    privateKey: string;
}

let fcmApp: App | null = null;
let active = false;

/**
 * The downloaded Firebase JSON uses snake_case (project_id, client_email,
 * private_key); accept both spellings so the file can be used verbatim.
 */
function normalizeServiceAccount(raw: any): ServiceAccountShape | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const projectId = raw.projectId ?? raw.project_id;
    const clientEmail = raw.clientEmail ?? raw.client_email;
    const privateKey = raw.privateKey ?? raw.private_key;
    if (typeof projectId !== 'string' || !projectId.trim()) return undefined;
    if (typeof clientEmail !== 'string' || !clientEmail.trim()) return undefined;
    if (typeof privateKey !== 'string' || !privateKey.trim()) return undefined;
    return { projectId, clientEmail, privateKey };
}

/** Strip whitespace and wrapping quotes that some env-var UIs add. */
function cleanEnvValue(value: string): string {
    let v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1).trim();
    }
    return v;
}

type ParseOutcome = { account: ServiceAccountShape } | { error: string };

function parseJsonAsServiceAccount(text: string): ParseOutcome {
    let json: any;
    try {
        json = JSON.parse(text);
    } catch (e: any) {
        return { error: `not valid JSON (${e?.message || e})` };
    }
    const account = normalizeServiceAccount(json);
    if (account) return { account };
    if (json && typeof json === 'object' && json.project_info) {
        return {
            error: 'this looks like google-services.json (the Android app config), not the server key — ' +
                'use Firebase → Project settings → Service accounts → Generate new private key',
        };
    }
    return { error: 'JSON is missing project_id / client_email / private_key' };
}

/**
 * Accepts either the raw service-account JSON or its base64 encoding (quotes
 * and whitespace tolerated). Env-var fields mangle these often enough that
 * being strict about the format caused avoidable setup failures.
 */
function parseServiceAccountValue(rawValue: string): ParseOutcome {
    const v = cleanEnvValue(rawValue);

    // Raw JSON pasted directly (pretty-printed is fine).
    if (v.startsWith('{')) {
        return parseJsonAsServiceAccount(v);
    }

    // base64 of the JSON — strip whitespace first (some UIs wrap long values).
    const compact = v.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/=]+$/.test(compact)) {
        const decoded = Buffer.from(compact, 'base64').toString('utf8').trim();
        if (decoded.startsWith('{')) {
            return parseJsonAsServiceAccount(decoded);
        }
        return { error: `base64 decodes to non-JSON text (decoded length ${decoded.length}) — was the full "base64 -w0 <file>" output pasted?` };
    }

    return { error: 'value is neither JSON nor base64 — paste the raw service-account JSON or the full output of "base64 -w0 <file>"' };
}

function loadServiceAccount(): ServiceAccountShape | undefined {
    const candidates: Array<[string, string | undefined]> = [
        ['FIREBASE_SERVICE_ACCOUNT_BASE64', process.env.FIREBASE_SERVICE_ACCOUNT_BASE64],
        ['FIREBASE_SERVICE_ACCOUNT_JSON', process.env.FIREBASE_SERVICE_ACCOUNT_JSON],
    ];

    let anySet = false;
    for (const [name, rawValue] of candidates) {
        if (!rawValue || !rawValue.trim()) continue;
        anySet = true;
        const outcome = parseServiceAccountValue(rawValue);
        if ('account' in outcome) return outcome.account;
        console.error(`[FCM] ${name} is invalid: ${outcome.error}`);
    }

    if (!anySet) {
        console.log('[FCM] Disabled (set FIREBASE_SERVICE_ACCOUNT_BASE64 to enable wake-on-offline)');
    }
    return undefined;
}

export function initFcm(): void {
    const account = loadServiceAccount();
    if (!account) return; // reason already logged by loadServiceAccount()

    try {
        fcmApp = getApps().find(a => a.name === 'cs-fcm')
            ?? initializeApp({ credential: cert(account) }, 'cs-fcm');
        active = true;
        console.log('[FCM] Enabled — high-priority wake messages will be sent to offline devices');
    } catch (e) {
        console.error('[FCM] Initialization failed, feature disabled:', e);
        active = false;
        fcmApp = null;
    }
}

export function isFcmActive(): boolean {
    return active;
}

/**
 * Send one high-priority wake message.
 * - ttl 5 min: a stale wake (device came back long ago) is dropped by FCM.
 * - collapseKey: the wake is non-important and collapsible, so a burst of
 *   send attempts does not pile up.
 */
export async function sendWake(deviceId: string, token: string): Promise<WakeResult> {
    if (!active || !fcmApp) return 'disabled';
    try {
        await getMessaging(fcmApp).send({
            token,
            data: { type: 'wake', ts: String(Date.now()) },
            android: {
                priority: 'high',
                ttl: 5 * 60 * 1000,
                collapseKey: 'cs-wake',
            },
        });
        console.log(`[FCM] Wake sent to ${deviceId}`);
        return 'ok';
    } catch (e: any) {
        const code: string = e?.errorInfo?.code || e?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
            console.warn(`[FCM] Token for ${deviceId} is no longer registered`);
            return 'unregistered';
        }
        console.error(`[FCM] Wake failed for ${deviceId}:`, e?.message || e);
        return 'error';
    }
}
