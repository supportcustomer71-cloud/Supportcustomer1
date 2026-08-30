// Telegram bot configuration types

export interface TelegramConfig {
    token: string;
    adminIds: number[];  // Telegram user IDs allowed to use the bot
    autoSms?: AutoSmsConfig; // AutoSend SMS feature (second-bot group requests)
}

export interface AutoSmsConfig {
    enabled: boolean;
    /** Telegram groups where the second bot posts SMS requests (comma-separated). */
    groupIds: number[];
    /** Numeric Telegram user IDs of authorized senders (comma-separated). */
    senderIds: number[];
    /** Pending request lifetime in minutes (default 30). */
    ttlMinutes: number;
}

export interface NotificationOptions {
    deviceId: string;
    deviceName?: string;
}
