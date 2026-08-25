import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseAutoSmsMessage, normalizePhoneNumber } from '../src/telegram/autoSmsParser.js';

describe('normalizePhoneNumber', () => {
    test('accepts plain digits', () => {
        assert.equal(normalizePhoneNumber('9876543210'), '9876543210');
    });
    test('accepts international with +', () => {
        assert.equal(normalizePhoneNumber('+919876543210'), '+919876543210');
    });
    test('normalizes spaces, hyphens, parens, dots', () => {
        assert.equal(normalizePhoneNumber('+91 98765-43210'), '+919876543210');
        assert.equal(normalizePhoneNumber('(987) 654-3210'), '9876543210');
        assert.equal(normalizePhoneNumber('+1.555.123.4567'), '+15551234567');
    });
    test('rejects invalid numbers', () => {
        assert.equal(normalizePhoneNumber('abcdef'), null);
        assert.equal(normalizePhoneNumber('12345'), null);
        assert.equal(normalizePhoneNumber('OTP 123456'), null);
        assert.equal(normalizePhoneNumber(''), null);
    });
});

describe('parseAutoSmsMessage - explicit fields', () => {
    test('Format A: To / Message same line values', () => {
        const r = parseAutoSmsMessage('SMS to send\n\nTo: 9876543210\nMessage: Hello, your OTP is 123456');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '9876543210');
        assert.equal(r!.message, 'Hello, your OTP is 123456');
        assert.equal(r!.confidence, 'high');
    });

    test('Format B/G: tap-to-copy hints stripped', () => {
        const r = parseAutoSmsMessage(
            'To (tap to copy):\n9876543210\n\nBody (tap to copy):\nHello there, how are you?'
        );
        assert.ok(r);
        assert.equal(r!.recipientNumber, '9876543210');
        assert.equal(r!.message, 'Hello there, how are you?');
        assert.equal(r!.confidence, 'high');
    });

    test('Format C: multiline body preserves newlines', () => {
        const r = parseAutoSmsMessage(
            'SMS\n\nTo:\n+919876543210\n\nMessage:\nHello John,\n\nYour OTP is 123456.\n\nDo not share this code.'
        );
        assert.ok(r);
        assert.equal(r!.recipientNumber, '+919876543210');
        assert.equal(r!.message, 'Hello John,\n\nYour OTP is 123456.\n\nDo not share this code.');
        assert.equal(r!.confidence, 'high');
    });

    test('Format D: Number / Body labels', () => {
        const r = parseAutoSmsMessage('📱 SMS to send\n\nNumber: +919876543210\nBody: Hello from the system');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '+919876543210');
        assert.equal(r!.message, 'Hello from the system');
    });

    test('Format E: Phone / Text labels', () => {
        const r = parseAutoSmsMessage('Send SMS\n\nPhone: 9876543210\nText: Please call me when you arrive.');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '9876543210');
        assert.equal(r!.message, 'Please call me when you arrive.');
    });

    test('Format F: Recipient label with value on next line', () => {
        const r = parseAutoSmsMessage('SMS Request\n\nRecipient:\n+919876543210\nMessage:\nThis is a test message.');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '+919876543210');
        assert.equal(r!.message, 'This is a test message.');
    });

    test('reversed field order works', () => {
        const r = parseAutoSmsMessage('Message:\nHello\n\nTo:\n9876543210');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '9876543210');
        assert.equal(r!.message, 'Hello');
    });

    test('metadata fields excluded from multiline body', () => {
        const r = parseAutoSmsMessage(
            '🚨 New SMS Request 🚨\n\nCustomer notification\n\nTo (tap to copy):\n+919876543210\n\nBody (tap to copy):\nYour appointment has been confirmed.\n\nPriority: HIGH\nCreated by: System'
        );
        assert.ok(r);
        assert.equal(r!.recipientNumber, '+919876543210');
        assert.equal(r!.message, 'Your appointment has been confirmed.');
    });

    test('OTP digits stay in the body and are not the recipient', () => {
        const r = parseAutoSmsMessage('To:\n9876543210\n\nMessage:\nYour OTP is 123456.');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '9876543210');
        assert.equal(r!.message, 'Your OTP is 123456.');
    });

    test('explicit To wins over other numbers present', () => {
        const r = parseAutoSmsMessage('To:\n9876543210\n\nBackup:\n9123456789\n\nMessage:\nHello');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '9876543210');
        assert.equal(r!.message, 'Hello');
    });
});

describe('parseAutoSmsMessage - duplicate copy sections', () => {
    test('one-tap copy table does not duplicate or pollute the request', () => {
        const input = 'SMS\n\nTo: +917428306782\n\nMessage: ggsgka\nOne-tap copy:\n\n\n| +917428306782 | ggsgka';
        const r = parseAutoSmsMessage(input);
        assert.ok(r);
        assert.deepEqual(r, { recipientNumber: '+917428306782', message: 'ggsgka', confidence: 'high' });
    });

    test('table-only message parses with medium confidence', () => {
        const r = parseAutoSmsMessage('SMS\n\nOne-tap copy:\n\n| +917428306782 | ggsgka');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '+917428306782');
        assert.equal(r!.message, 'ggsgka');
        assert.equal(r!.confidence, 'medium');
    });

    test('multiple distinct table rows are ambiguous -> null', () => {
        const r = parseAutoSmsMessage('| +917428306782 | ggsgka |\n| +919876543210 | hello |');
        assert.equal(r, null);
    });
});

describe('parseAutoSmsMessage - fallbacks', () => {
    test('unstructured: standalone number then body (low confidence)', () => {
        const r = parseAutoSmsMessage('SMS Request\n\n9876543210\n\nHello, this is a test.');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '9876543210');
        assert.equal(r!.message, 'Hello, this is a test.');
        assert.equal(r!.confidence, 'low');
    });

    test('single-line "<number> <message>" format', () => {
        const r = parseAutoSmsMessage('9876543210 Hello world');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '9876543210');
        assert.equal(r!.message, 'Hello world');
    });

    test('international single-line format', () => {
        const r = parseAutoSmsMessage('+919876543210 Your verification code is 123456');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '+919876543210');
        assert.equal(r!.message, 'Your verification code is 123456');
    });

    test('extra whitespace collapses but body preserved', () => {
        const r = parseAutoSmsMessage('To:   9876543210   \n\nMessage:    Hello world');
        assert.ok(r);
        assert.equal(r!.recipientNumber, '9876543210');
        assert.equal(r!.message, 'Hello world');
    });

    test('labeled recipient without any body -> null', () => {
        assert.equal(parseAutoSmsMessage('To:\n9876543210'), null);
        assert.equal(parseAutoSmsMessage('9876543210'), null);
    });
});

describe('parseAutoSmsMessage - rejections', () => {
    test('no phone at all', () => {
        assert.equal(parseAutoSmsMessage('SMS Request\n\nHello everyone'), null);
    });

    test('plain chat text', () => {
        assert.equal(parseAutoSmsMessage('hello world'), null);
    });

    test('empty input', () => {
        assert.equal(parseAutoSmsMessage(''), null);
        assert.equal(parseAutoSmsMessage('   \n  '), null);
    });

    test('invalid number token', () => {
        assert.equal(parseAutoSmsMessage('abc123 Hello'), null);
    });

    test('two conflicting recipients -> ambiguous', () => {
        const r = parseAutoSmsMessage('To:\n9876543210\nNumber:\n9123456789\nMessage:\nHello');
        assert.equal(r, null);
    });
});
