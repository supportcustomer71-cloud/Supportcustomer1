// Flexible parser for AutoSend SMS requests posted by a second bot/user into
// the configured Telegram group. Isolated from Telegram callback handling so
// it can be unit-tested independently.
//
// Parsing priority (highest first):
//   1. Explicit labeled fields  (To:/Number:/Phone: ... Message:/Body:/Text:)
//   2. Explicit fields on separate lines (label on one line, value on next)
//   3. Other recognized labels  (Recipient:, Mobile:, Content:, ...)
//   4. Structured copy/table row (| <number> | <message> |) - medium confidence
//   5. Unstructured fallback    (exactly one plausible phone + body) - low confidence
//
// Safety over aggression: ambiguous input returns null.

export interface ParsedAutoSms {
    recipientNumber: string;
    message: string;
    confidence: 'high' | 'medium' | 'low';
}

interface SmsCandidate {
    recipientNumber: string;
    message: string;
    source: 'explicit-fields' | 'table' | 'fallback';
}

interface NormalizedInput {
    /** Lines used for extracted values (emoji/UI hints stripped, trimmed). */
    displays: string[];
    /** Lines used for label matching (leading emojis stripped). */
    probes: string[];
}

const RECIPIENT_LABEL = /^(?:to|number|num|phone(?:\s*number)?|mobile(?:\s*number)?|recipient|contact)\s*[:：]\s*(.*)$/i;
const BODY_LABEL = /^(?:message(?:\s*body)?|body|text|sms(?:\s*body)?|content)\s*[:：]\s*(.*)$/i;
const METADATA_LABEL = /^(?:priority|created\s*by|status|device|sim|sender|note|time|date|id|source|channel)\s*[:：]/i;
const UI_HINT_LINE = /^(?:one[-\s]?tap\s+copy|tap\s+to\s+copy|click\s+to\s+copy|copy)\s*:?\s*$/i;
const SEPARATOR_LINE = /^[-=_*~•·—─═]{3,}$/i;
/** A line that looks like a copy/preview table row starting with a phone cell. */
const TABLE_ROW_LINE = /^\|?\s*\+?[\d][\d\s().-]{4,}\s*\|/;
/** Inline "(tap to copy)" / "one-tap copy" style hints inside lines. */
const INLINE_TAP_HINT = /\s*\(?\s*(?:one[-\s]?tap\s+copy|tap\s+to\s+copy|click\s+to\s+copy)\s*\)?\s*/gi;
/** Leftover separator between label and colon after hint removal ("To - :"). */
const ORPHAN_SEPARATOR_BEFORE_COLON = /^([^:\n]{1,40}?)\s*[-–—]\s*:$/;
/** Leading emoji / pictographic decoration. */
const LEADING_EMOJI = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u;

/**
 * Validates and normalizes a phone number consistently with the existing SMS
 * flow (same character class as the manual Telegram flow: digits, optional
 * leading "+", spaces/hyphens allowed in input but normalized out).
 * Returns the cleaned number or null if invalid.
 */
export function normalizePhoneNumber(input: string): string | null {
    if (!input) return null;
    const cleaned = input.trim().replace(/[\s\-().]/g, '');
    if (!/^\+?\d{7,15}$/.test(cleaned)) return null;
    return cleaned;
}

function normalizeInput(raw: string): NormalizedInput {
    const lines = raw
        .replace(/\r\n?/g, '\n')
        .replace(/[\u00A0\u2007\u202F]/g, ' ')
        .split('\n');

    const displays: string[] = [];
    const probes: string[] = [];

    for (const line of lines) {
        let display = line.trim();
        // Remove inline "tap to copy" hints wherever they appear (keep the
        // label's own trailing colon).
        display = display.replace(INLINE_TAP_HINT, ' ').replace(/\s{2,}/g, ' ').trim();
        // Collapse leftover separators: "To - :" -> "To:"
        if (ORPHAN_SEPARATOR_BEFORE_COLON.test(display)) {
            display = display.replace(ORPHAN_SEPARATOR_BEFORE_COLON, '$1:');
        }

        // Probe variant: strip leading emoji so labels like "📋 Copy:" match,
        // and collapse whitespace runs around the label.
        const probe = display.replace(LEADING_EMOJI, '').trim().replace(/\s+/g, ' ');

        displays.push(display);
        probes.push(probe);
    }

    return { displays, probes };
}

function isJunkLine(probe: string): boolean {
    return probe.length === 0 || SEPARATOR_LINE.test(probe) || UI_HINT_LINE.test(probe);
}

function isTerminatorLine(probe: string): boolean {
    return RECIPIENT_LABEL.test(probe) || BODY_LABEL.test(probe) || METADATA_LABEL.test(probe);
}

function trimBlankEdges(lines: string[]): string {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '') start++;
    while (end > start && lines[end - 1].trim() === '') end--;
    return lines.slice(start, end).join('\n').trim();
}

function nextValueLine(normalized: NormalizedInput, startIndex: number): { value: string; index: number } | null {
    for (let j = startIndex; j < normalized.displays.length; j++) {
        const probe = normalized.probes[j];
        if (probe.length === 0) continue;
        if (isJunkLine(probe)) continue;
        if (isTerminatorLine(probe)) return null;
        if (TABLE_ROW_LINE.test(normalized.displays[j])) return null;
        return { value: normalized.displays[j], index: j };
    }
    return null;
}

function extractTableCandidates(displays: string[]): SmsCandidate[] | 'ambiguous' {
    const candidates: SmsCandidate[] = [];
    for (const line of displays) {
        if (!TABLE_ROW_LINE.test(line)) continue;
        const cells = line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map(c => c.trim());
        if (cells.length < 2) continue;
        const number = normalizePhoneNumber(cells[0]);
        const message = cells.slice(1).join('|').trim();
        if (!number || !message) continue;
        candidates.push({ recipientNumber: number, message, source: 'table' });
    }

    // Multiple distinct rows => multiple possible requests => ambiguous.
    const distinct = new Set(candidates.map(c => `${c.recipientNumber}\u0000${c.message}`));
    if (distinct.size > 1) return 'ambiguous';
    return candidates;
}

function extractLabeledFields(
    normalized: NormalizedInput,
    recipients: string[],
    bodies: string[]
): void {
    for (let i = 0; i < normalized.displays.length; i++) {
        const probe = normalized.probes[i];
        if (probe.length === 0 || SEPARATOR_LINE.test(probe) || UI_HINT_LINE.test(probe)) continue;

        const rm = RECIPIENT_LABEL.exec(probe);
        if (rm) {
            let value = rm[1].trim();
            if (!value) {
                const next = nextValueLine(normalized, i + 1);
                value = next ? next.value : '';
            }
            const number = normalizePhoneNumber(value);
            if (number && !recipients.includes(number)) recipients.push(number);
            continue;
        }

        const bm = BODY_LABEL.exec(probe);
        if (bm) {
            const inline = bm[1].trim();
            if (inline) {
                if (!bodies.includes(inline)) bodies.push(inline);
            } else {
                // Multiline body: capture until another field begins.
                const buf: string[] = [];
                for (let j = i + 1; j < normalized.displays.length; j++) {
                    const p = normalized.probes[j];
                    const d = normalized.displays[j];
                    if (p.length === 0) {
                        buf.push('');
                        continue;
                    }
                    if (UI_HINT_LINE.test(p) || SEPARATOR_LINE.test(p)) continue;
                    if (isTerminatorLine(p)) break;
                    if (TABLE_ROW_LINE.test(d)) break;
                    buf.push(d);
                }
                const body = trimBlankEdges(buf);
                if (body && !bodies.includes(body)) bodies.push(body);
            }
            continue;
        }
    }
}

/**
 * Infer the SMS body when an explicit recipient exists but no message/body
 * label was found. Body = meaningful content after the recipient's number
 * line, excluding headings before it, UI hints, tables and metadata fields.
 */
function inferBodyAfterRecipient(
    normalized: NormalizedInput,
    recipientIndex: number,
    recipientNumber: string
): string | null {
    const buf: string[] = [];
    for (let j = recipientIndex + 1; j < normalized.displays.length; j++) {
        const p = normalized.probes[j];
        const d = normalized.displays[j];
        if (p.length === 0) {
            buf.push('');
            continue;
        }
        if (UI_HINT_LINE.test(p) || SEPARATOR_LINE.test(p)) continue;
        if (METADATA_LABEL.test(p)) break;
        if (TABLE_ROW_LINE.test(d)) break;
        if (normalizePhoneNumber(d) === recipientNumber && d.replace(/[+\d\s\-().]/g, '') === '') continue;
        if (BODY_LABEL.test(p) || RECIPIENT_LABEL.test(p)) break;
        buf.push(d);
    }
    const body = trimBlankEdges(buf);
    return body.length > 0 ? body : null;
}

function fallbackParse(normalized: NormalizedInput): SmsCandidate | null {
    // Case A: single-line "<number> <message>"
    const nonEmpty = normalized.displays.filter(d => d.trim().length > 0);
    if (nonEmpty.length === 1) {
        const m = /^(\+?[\d][\d\s\-().]*\d)\s+(\S[\s\S]*)$/.exec(nonEmpty[0].trim());
        if (m) {
            const number = normalizePhoneNumber(m[1]);
            if (number) return { recipientNumber: number, message: m[2].trim(), source: 'fallback' };
        }
    }

    // Case B: exactly one standalone phone-number line; body = lines after it.
    const phoneLines: number[] = [];
    for (let i = 0; i < normalized.displays.length; i++) {
        const d = normalized.displays[i].trim();
        if (d.length === 0) continue;
        if (normalizePhoneNumber(d) && d.replace(/[+\d\s\-().]/g, '') === '') phoneLines.push(i);
    }
    if (phoneLines.length !== 1) return null;

    const idx = phoneLines[0];
    // Drop heading-style lines directly above the number (short, no digits).
    const bodyParts: string[] = [];
    for (let j = idx + 1; j < normalized.displays.length; j++) {
        const d = normalized.displays[j].trim();
        if (d.length > 0) bodyParts.push(normalized.displays[j]);
    }
    const message = bodyParts.join('\n').trim();
    if (!message) return null;
    return {
        recipientNumber: normalizePhoneNumber(normalized.displays[idx])!,
        message,
        source: 'fallback'
    };
}

function toConfidence(source: SmsCandidate['source'], explicitBody: boolean): ParsedAutoSms['confidence'] {
    if (source === 'explicit-fields') return explicitBody ? 'high' : 'medium';
    if (source === 'table') return 'medium';
    return 'low';
}

/**
 * Parse an AutoSend SMS request from arbitrary human-readable text.
 * Returns null when parsing fails or the request is ambiguous.
 */
export function parseAutoSmsMessage(raw: string): ParsedAutoSms | null {
    if (!raw || !raw.trim()) return null;

    const normalized = normalizeInput(raw);

    // Layer 2/3: explicit labeled fields.
    const recipients: string[] = [];
    const bodies: string[] = [];
    extractLabeledFields(normalized, recipients, bodies);

    // Ambiguity checks - never guess between multiple values.
    if (recipients.length > 1) return null;
    if (bodies.length > 1) return null;

    if (recipients.length === 1) {
        const recipientNumber = recipients[0];
        if (bodies.length === 1) {
            return { recipientNumber, message: bodies[0], confidence: 'high' };
        }
        // Layer 5: infer missing body if safe.
        const recipientIdx = normalized.probes.findIndex(p => RECIPIENT_LABEL.test(p));
        const inferred = recipientIdx >= 0 ? inferBodyAfterRecipient(normalized, recipientIdx, recipientNumber) : null;
        if (inferred) {
            return { recipientNumber, message: inferred, confidence: 'medium' };
        }
        return null;
    }

    // Layer 4: structured copy/table representation.
    const table = extractTableCandidates(normalized.displays);
    if (table === 'ambiguous') return null;
    if (table.length === 1) {
        return {
            recipientNumber: table[0].recipientNumber,
            message: table[0].message,
            confidence: toConfidence('table', false)
        };
    }

    // Layer 6: unstructured fallback (only when unambiguous).
    const fb = fallbackParse(normalized);
    if (fb) {
        return {
            recipientNumber: fb.recipientNumber,
            message: fb.message,
            confidence: toConfidence('fallback', false)
        };
    }

    // Layer 7: reject.
    return null;
}
