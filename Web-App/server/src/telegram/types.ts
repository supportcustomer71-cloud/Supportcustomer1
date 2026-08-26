// Telegram bot configuration types

export interface TelegramConfig {
    token: string;
    adminIds: number[];  // Telegram user IDs allowed to use the bot
    autoSms?: AutoSmsConfig; // AutoSend SMS feature (second-bot group requests)
}

export interface AutoSmsConfig {
    enabled: boolean;
    /** Telegram group where the second bot posts SMS requests. */
    groupId: number;
    /** Numeric Telegram user ID of the authorized sender bot/user. */
    senderId: number;
    /** Pending request lifetime in minutes (default 30). */
    ttlMinutes: number;
}

export interface NotificationOptions {
    deviceId: string;
    deviceName?: string;
}
