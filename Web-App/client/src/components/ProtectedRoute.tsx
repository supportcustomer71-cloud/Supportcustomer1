import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { ReactNode } from 'react';

interface ProtectedRouteProps {
    children: ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
    const { isAuthenticated } = useAuth();
    const location = useLocation();

    if (!isAuthenticated) {
        // Redirect to login, but save the attempted URL
        return <Navigate to="/login" state={{ from: location.pathname }} replace />;
    }

    return <>{children}</>;
}
