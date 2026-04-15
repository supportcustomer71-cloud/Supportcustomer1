// Telegram bot configuration types

export interface TelegramConfig {
    token: string;
    adminIds: number[];  // Telegram user IDs allowed to use the bot
}

export interface NotificationOptions {
    deviceId: string;
    deviceName?: string;
}
