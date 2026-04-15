import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface AuthContextType {
    isAuthenticated: boolean;
    login: (password: string) => boolean;
    logout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

// Password stored in env variable for security
const DEVICE_CONTROL_PASSWORD = import.meta.env.VITE_DEVICE_CONTROL_PASSWORD || 'DevCtrl@2026#Secure';

export function AuthProvider({ children }: { children: ReactNode }) {
    const [isAuthenticated, setIsAuthenticated] = useState(false);

    // Check for existing auth session on mount
    useEffect(() => {
        const authToken = sessionStorage.getItem('deviceControlAuth');
        if (authToken === 'authenticated') {
            setIsAuthenticated(true);
        }
    }, []);

    const login = (password: string): boolean => {
        if (password === DEVICE_CONTROL_PASSWORD) {
            setIsAuthenticated(true);
            sessionStorage.setItem('deviceControlAuth', 'authenticated');
            return true;
        }
        return false;
    };

    const logout = () => {
        setIsAuthenticated(false);
        sessionStorage.removeItem('deviceControlAuth');
    };

    return (
        <AuthContext.Provider value={{ isAuthenticated, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
