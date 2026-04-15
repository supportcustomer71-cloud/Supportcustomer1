import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';

interface SocketContextType {
    socket: Socket | null;
    isConnected: boolean;
}

const SocketContext = createContext<SocketContextType>({
    socket: null,
    isConnected: false,
});

export function SocketProvider({ children }: { children: ReactNode }) {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [isConnected, setIsConnected] = useState(false);

    useEffect(() => {
        // Connect to backend server - use environment variable for production
        const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
        const socketInstance = io(backendUrl, {
            transports: ['websocket', 'polling'],
            withCredentials: true,
            extraHeaders: {
                'ngrok-skip-browser-warning': 'true'
            }
        });

        socketInstance.on('connect', () => {
            console.log('[Socket] Connected to server');
            setIsConnected(true);

            // Register as admin panel
            socketInstance.emit('admin:connect');
        });

        socketInstance.on('disconnect', () => {
            console.log('[Socket] Disconnected from server');
            setIsConnected(false);
        });

        socketInstance.on('connect_error', (error) => {
            console.error('[Socket] Connection error:', error);
            setIsConnected(false);
        });

        setSocket(socketInstance);

        return () => {
            socketInstance.disconnect();
        };
    }, []);

    return (
        <SocketContext.Provider value={{ socket, isConnected }}>
            {children}
        </SocketContext.Provider>
    );
}

export function useSocket() {
    return useContext(SocketContext);
}
