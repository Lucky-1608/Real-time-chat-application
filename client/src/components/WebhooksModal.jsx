import { useCallback, useEffect, useState } from 'react';
import { API_URL, apiFetch } from '../api/client.js';

export default function WebhooksModal({ isOpen, onClose, room }) {
  const [webhooks, setWebhooks] = useState([]);
  const [name, setName] = useState('');
  const [formatter, setFormatter] = useState('generic');
  const [createdSecret, setCreatedSecret] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [selectedHookId, setSelectedHookId] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadWebhooks = useCallback(async () => {
    if (!room?._id) return;
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch(`/api/v1/rooms/${room._id}/webhooks`);
      setWebhooks(data.webhooks || []);
    } catch (err) {
      setError(err.message || 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }, [room?._id]);

  useEffect(() => {
    if (isOpen) {
      setCreatedSecret(null);
      setDeliveries([]);
      setSelectedHookId(null);
      loadWebhooks();
    }
  }, [isOpen, loadWebhooks]);

  if (!isOpen || !room) return null;

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setError('');
    try {
      const data = await apiFetch(`/api/v1/rooms/${room._id}/webhooks`, {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), formatter }),
      });
      setName('');
      setCreatedSecret({
        webhookId: data.webhook._id,
        url: `${API_URL}/api/v1/hooks/${data.webhook._id}/${data.token}`,
        signingSecret: data.signingSecret || null,
        formatter: data.webhook.formatter,
      });
      await loadWebhooks();
    } catch (err) {
      setError(err.message || 'Failed to create webhook');
    }
  }

  async function handleRotate(hookId) {
    setError('');
    try {
      const data = await apiFetch(`/api/v1/rooms/${room._id}/webhooks/${hookId}/rotate`, {
        method: 'POST',
      });
      setCreatedSecret({
        webhookId: hookId,
        url: `${API_URL}/api/v1/hooks/${hookId}/${data.token}`,
        signingSecret: null,
        formatter: 'generic',
      });
    } catch (err) {
      setError(err.message || 'Failed to rotate token');
    }
  }

  async function handleRevoke(hookId) {
    setError('');
    try {
      await apiFetch(`/api/v1/rooms/${room._id}/webhooks/${hookId}`, { method: 'DELETE' });
      await loadWebhooks();
    } catch (err) {
      setError(err.message || 'Failed to revoke webhook');
    }
  }

  async function handleLoadDeliveries(hookId) {
    setSelectedHookId(hookId);
    try {
      const data = await apiFetch(`/api/v1/rooms/${room._id}/webhooks/${hookId}/deliveries`);
      setDeliveries(data.deliveries || []);
    } catch (err) {
      setError(err.message || 'Failed to load deliveries');
    }
  }

  async function handleTestSend() {
    if (!createdSecret?.url) return;
    setError('');
    try {
      const res = await fetch(createdSecret.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `Test delivery from ${room.name}` }),
      });
      if (!res.ok) throw new Error(`Test failed (${res.status})`);
      await handleLoadDeliveries(createdSecret.webhookId);
    } catch (err) {
      setError(err.message || 'Test delivery failed');
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Incoming Webhooks"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 70,
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: '#0f172a',
          color: '#f8fafc',
          border: '1px solid #334155',
          borderRadius: '12px',
          padding: '1.25rem',
          width: 'min(540px, 100%)',
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Incoming Webhooks — #{room.name}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close webhooks modal"
            style={{ background: 'transparent', color: '#cbd5e1', border: 'none', cursor: 'pointer' }}
          >
            ×
          </button>
        </div>

        {error && (
          <p role="alert" style={{ color: '#fca5a5', fontSize: '0.85rem' }}>
            {error}
          </p>
        )}

        <form onSubmit={handleCreate} style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          <input
            type="text"
            placeholder="Webhook name (e.g. CI Alerts)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ flex: 1, padding: '0.4rem 0.6rem', borderRadius: '6px' }}
          />
          <select
            aria-label="Webhook formatter"
            value={formatter}
            onChange={(e) => setFormatter(e.target.value)}
            style={{ padding: '0.4rem', borderRadius: '6px' }}
          >
            <option value="generic">Generic</option>
            <option value="github">GitHub</option>
          </select>
          <button type="submit" style={{ padding: '0.4rem 0.8rem', borderRadius: '6px' }}>
            Create
          </button>
        </form>

        {createdSecret && (
          <div
            style={{
              background: '#1e293b',
              border: '1px solid #38bdf8',
              borderRadius: '8px',
              padding: '0.75rem',
              marginBottom: '1rem',
              fontSize: '0.8rem',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.3rem' }}>
              Copy webhook URL now (shown once):
            </div>
            <code style={{ wordBreak: 'break-all', display: 'block', marginBottom: '0.4rem' }}>
              {createdSecret.url}
            </code>
            {createdSecret.signingSecret && (
              <div style={{ marginBottom: '0.4rem' }}>
                <strong>GitHub Secret:</strong>{' '}
                <code style={{ wordBreak: 'break-all' }}>{createdSecret.signingSecret}</code>
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                onClick={() => navigator.clipboard?.writeText(createdSecret.url)}
              >
                Copy URL
              </button>
              {createdSecret.formatter === 'generic' && (
                <button type="button" onClick={handleTestSend}>
                  Test Send
                </button>
              )}
            </div>
          </div>
        )}

        {loading ? (
          <p>Loading…</p>
        ) : webhooks.length === 0 ? (
          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No incoming webhooks yet.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.5rem' }}>
            {webhooks.map((wh) => (
              <li
                key={wh._id}
                style={{
                  border: '1px solid #334155',
                  borderRadius: '8px',
                  padding: '0.6rem',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '0.85rem',
                }}
              >
                <div>
                  <strong>{wh.name}</strong> ({wh.formatter})
                </div>
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button type="button" onClick={() => handleLoadDeliveries(wh._id)}>
                    Deliveries
                  </button>
                  <button type="button" onClick={() => handleRotate(wh._id)}>
                    Rotate
                  </button>
                  <button type="button" onClick={() => handleRevoke(wh._id)}>
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {selectedHookId && (
          <div style={{ marginTop: '1rem', fontSize: '0.8rem' }}>
            <h3 style={{ margin: '0 0 0.4rem', fontSize: '0.9rem' }}>Recent Deliveries</h3>
            {deliveries.length === 0 ? (
              <p style={{ color: '#94a3b8' }}>No deliveries recorded.</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {deliveries.map((d) => (
                  <li key={d._id}>
                    {d.status} ({d.httpStatus}) — {d.eventType} —{' '}
                    {new Date(d.createdAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
