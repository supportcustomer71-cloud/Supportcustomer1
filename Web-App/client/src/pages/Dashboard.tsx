import { Link } from 'react-router-dom';
import { useDevices } from '../contexts/DeviceContext';
import { useSocket } from '../contexts/SocketContext';
import { Device } from '../types';

function DeviceCard({ device }: { device: Device }) {
    const lastSeen = new Date(device.lastSeen).toLocaleString();

    return (
        <Link to={`/device/${device.id}`} style={{ textDecoration: 'none' }}>
            <div className="glass-card device-card clickable">
                <div className="device-header">
                    <div className="device-icon">📱</div>
                    <div className="device-info">
                        <h3>{device.name}</h3>
                        <p>{device.phoneNumber}</p>
                    </div>
                </div>

                <div className={`device-status ${device.status}`}>
                    <span className={`status-dot ${device.status}`}></span>
                    {device.status}
                </div>

                <div className="device-stats">
                    <div className="device-stat">
                        <div className="device-stat-value">—</div>
                        <div className="device-stat-label">SMS</div>
                    </div>
                    <div className="device-stat">
                        <div className="device-stat-value">—</div>
                        <div className="device-stat-label">Calls</div>
                    </div>
                    <div className="device-stat">
                        <div className="device-stat-value">—</div>
                        <div className="device-stat-label">Forms</div>
                    </div>
                </div>

                <div style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    Last seen: {lastSeen}
                </div>
            </div>
        </Link>
    );
}

export default function Dashboard() {
    const { devices } = useDevices();
    const { isConnected } = useSocket();

    return (
        <div className="app-container">
            <header className="header">
                <div className="header-title">
                    <span className="header-logo">📱</span>
                    <h1>Device Control Panel</h1>
                </div>
                <div className="header-status">
                    <span className={`status-dot ${isConnected ? 'online' : 'offline'}`}></span>
                    {isConnected ? 'Connected to Server' : 'Disconnected'}
                </div>
            </header>

            <main>
                {devices.length === 0 ? (
                    <div className="glass-card empty-state">
                        <div className="empty-state-icon">📡</div>
                        <h2>No Devices Connected</h2>
                        <p>
                            Waiting for devices to connect. When an Android device connects,
                            it will appear here.
                        </p>
                        <div style={{ marginTop: '2rem', padding: '1rem', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', textAlign: 'left' }}>
                            <p style={{ fontWeight: 500, marginBottom: '0.5rem' }}>📋 Connection Details:</p>
                            <code style={{ fontSize: '0.875rem', color: 'var(--accent-primary)' }}>
                                Server: ws://localhost:3001
                            </code>
                        </div>
                    </div>
                ) : (
                    <>
                        <div style={{ marginBottom: '1.5rem' }}>
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>
                                Connected Devices ({devices.length})
                            </h2>
                        </div>
                        <div className="devices-grid">
                            {devices.map(device => (
                                <DeviceCard key={device.id} device={device} />
                            ))}
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}
