import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

// TODO: set your Telegram channel link + label here.
const TELEGRAM_CHANNEL_URL = 'https://t.me/yourchannel';
const TELEGRAM_CHANNEL_LABEL = 'Join our Telegram channel';
const TELEGRAM_CHANNEL_HINT = 'Get updates and support';

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

                {/* Telegram channel banner */}
                <a
                    href={TELEGRAM_CHANNEL_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={TELEGRAM_CHANNEL_LABEL}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        marginTop: '1.25rem',
                        padding: '0.875rem 1rem',
                        borderRadius: 'var(--radius-md)',
                        background: 'linear-gradient(135deg, rgba(34, 158, 217, 0.18), rgba(34, 158, 217, 0.06))',
                        border: '1px solid rgba(34, 158, 217, 0.45)',
                        textDecoration: 'none',
                        color: 'var(--text-primary)',
                        transition: 'transform 0.15s ease, box-shadow 0.15s ease'
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(34, 158, 217, 0.25)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
                >
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="#229ED9" aria-hidden="true" style={{ flex: '0 0 auto' }}>
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.19-.08-.05-.19-.02-.27 0-.12.04-1.96 1.25-5.54 3.65-.52.36-1 .53-1.42.52-.47-.01-1.37-.27-2.03-.48-.82-.27-1.47-.41-1.43-.87.02-.24.36-.49 1.02-.74 3.98-1.73 6.63-2.88 7.96-3.43 3.79-1.58 4.58-1.85 5.09-1.86.11 0 .36.03.52.18.13.13.17.3.18.42-.01.1-.01.2-.02.28z" />
                    </svg>
                    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{TELEGRAM_CHANNEL_LABEL}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{TELEGRAM_CHANNEL_HINT}</span>
                    </span>
                    <span style={{ marginLeft: 'auto', color: '#229ED9', fontWeight: 700, fontSize: '1.1rem' }}>›</span>
                </a>

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
