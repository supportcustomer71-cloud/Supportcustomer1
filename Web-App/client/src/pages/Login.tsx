import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const { login } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    // Get the redirect path from location state, or default to dashboard
    const from = (location.state as { from?: string })?.from || '/';

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        // Small delay for UX
        setTimeout(() => {
            const success = login(password);
            if (success) {
                navigate(from, { replace: true });
            } else {
                setError('Invalid password. Access denied.');
                setPassword('');
            }
            setIsLoading(false);
        }, 300);
    };

    return (
        <div className="app-container" style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100vh',
            padding: '1rem'
        }}>
            <div className="glass-card" style={{
                maxWidth: '400px',
                width: '100%',
                padding: '2rem'
            }}>
                <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
                    <div style={{
                        fontSize: '3rem',
                        marginBottom: '1rem',
                        filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.3))'
                    }}>
                        🔐
                    </div>
                    <h1 style={{
                        fontSize: '1.5rem',
                        fontWeight: 700,
                        background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text'
                    }}>
                        Device Control Access
                    </h1>
                    <p style={{
                        color: 'var(--text-muted)',
                        marginTop: '0.5rem',
                        fontSize: '0.875rem'
                    }}>
                        Enter password to access device controls
                    </p>
                </div>

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label className="form-label">Password</label>
                        <input
                            type="password"
                            className="form-input"
                            placeholder="Enter access password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            autoFocus
                            disabled={isLoading}
                            style={{
                                fontSize: '1rem',
                                padding: '0.875rem 1rem'
                            }}
                        />
                    </div>

                    {error && (
                        <div style={{
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.3)',
                            borderRadius: 'var(--radius-md)',
                            padding: '0.75rem',
                            marginBottom: '1rem',
                            color: '#ef4444',
                            fontSize: '0.875rem',
                            textAlign: 'center'
                        }}>
                            ⚠️ {error}
                        </div>
                    )}

                    <button
                        type="submit"
                        className="btn btn-primary"
                        disabled={!password.trim() || isLoading}
                        style={{
                            width: '100%',
                            padding: '0.875rem',
                            fontSize: '1rem',
                            fontWeight: 600,
                            opacity: (!password.trim() || isLoading) ? 0.6 : 1
                        }}
                    >
                        {isLoading ? '🔄 Verifying...' : '🔓 Unlock Access'}
                    </button>
                </form>

                <div style={{
                    marginTop: '1.5rem',
                    textAlign: 'center',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)'
                }}>
                    Protected area • Session expires on browser close
                </div>
            </div>
        </div>
    );
}
