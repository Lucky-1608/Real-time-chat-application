import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';
import Modal from './Modal.jsx';
import styles from './SecuritySettingsModal.module.css';

export default function AdminDashboardModal({ isOpen, onClose }) {
  const [tab, setTab] = useState('stats');
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [reports, setReports] = useState([]);
  const [audits, setAudits] = useState([]);
  const [userQuery, setUserQuery] = useState('');
  const [error, setError] = useState('');

  const loadTab = useCallback(async (activeTab, q = '') => {
    setError('');
    try {
      if (activeTab === 'stats') {
        setStats(await apiFetch('/api/admin/stats'));
      } else if (activeTab === 'users') {
        const data = await apiFetch(`/api/admin/users?q=${encodeURIComponent(q)}`);
        setUsers(data.users || []);
      } else if (activeTab === 'rooms') {
        const data = await apiFetch('/api/admin/rooms');
        setRooms(data.rooms || []);
      } else if (activeTab === 'reports') {
        const data = await apiFetch('/api/reports');
        setReports(data.reports || []);
      } else if (activeTab === 'audit') {
        const data = await apiFetch('/api/admin/audit?limit=30');
        setAudits(data.events || []);
      }
    } catch (err) {
      setError(err.message || 'Failed to load admin data');
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadTab(tab, '');
    }
  }, [isOpen, tab, loadTab]);

  if (!isOpen) return null;

  async function handleSuspendToggle(u) {
    const endpoint = u.suspendedAt
      ? `/api/admin/users/${u.id}/unsuspend`
      : `/api/admin/users/${u.id}/suspend`;
    await apiFetch(endpoint, { method: 'POST', body: JSON.stringify({}) });
    loadTab('users', userQuery);
  }

  async function handleForceLogout(userId) {
    await apiFetch(`/api/admin/users/${userId}/force-logout`, { method: 'POST' });
    loadTab('users', userQuery);
  }

  async function handleReportAction(reportId, action) {
    await apiFetch(`/api/reports/${reportId}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    loadTab('reports');
  }

  const maxDayCount = Math.max(1, ...(stats?.messagesPerDay || []).map((d) => d.count));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Admin Dashboard">
      <div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          {['stats', 'users', 'rooms', 'reports', 'audit'].map((t) => (
            <button
              key={t}
              type="button"
              className={tab === t ? styles.primaryBtn : styles.secondaryBtn}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {tab === 'stats' && stats && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginBottom: '1rem' }}>
              <div>Users: <strong>{stats.usersCount}</strong> ({stats.suspendedCount} suspended)</div>
              <div>Rooms: <strong>{stats.roomsCount}</strong></div>
              <div>Active sockets: <strong>{stats.activeSockets}</strong></div>
              <div>Uploads: <strong>{stats.uploadsCount}</strong></div>
              <div>Scan rejections: <strong>{stats.scanRejectionsCount}</strong></div>
            </div>
            <h4>Messages / day (7d)</h4>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', height: '80px', paddingTop: '8px' }}>
              {(stats.messagesPerDay || []).map((d) => (
                <div key={d.date} style={{ flex: 1, textAlign: 'center', fontSize: '0.7rem' }}>
                  <div
                    style={{
                      height: `${Math.max(6, Math.round((d.count / maxDayCount) * 55))}px`,
                      background: 'var(--accent, #6366f1)',
                      borderRadius: '3px',
                    }}
                    title={`${d.date}: ${d.count}`}
                  />
                  <span>{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'users' && (
          <div>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="search"
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="Search username…"
                className={styles.input}
              />
              <button type="button" className={styles.secondaryBtn} onClick={() => loadTab('users', userQuery)}>
                Search
              </button>
            </div>
            <ul style={{ maxHeight: '260px', overflowY: 'auto', listStyle: 'none', padding: 0 }}>
              {users.map((u) => (
                <li key={u.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  <span>
                    {u.username} {u.suspendedAt ? '(Suspended)' : ''}
                  </span>
                  <span style={{ display: 'flex', gap: '0.35rem' }}>
                    <button type="button" className={styles.secondaryBtn} onClick={() => handleSuspendToggle(u)}>
                      {u.suspendedAt ? 'Unsuspend' : 'Suspend'}
                    </button>
                    <button type="button" className={styles.secondaryBtn} onClick={() => handleForceLogout(u.id)}>
                      Force Logout
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === 'rooms' && (
          <ul style={{ maxHeight: '260px', overflowY: 'auto', listStyle: 'none', padding: 0 }}>
            {rooms.map((r) => (
              <li key={r.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.35rem 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <span>{r.name} ({r.type})</span>
                <span>{r.memberCount} members</span>
              </li>
            ))}
          </ul>
        )}

        {tab === 'reports' && (
          <ul style={{ maxHeight: '260px', overflowY: 'auto', listStyle: 'none', padding: 0 }}>
            {reports.map((rep) => (
              <li key={rep._id} style={{ padding: '0.45rem 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <div>
                  <strong>{rep.reason}</strong> ({rep.status}) — {rep.messageSnapshot || rep.targetType}
                </div>
                {rep.status === 'open' && (
                  <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.25rem' }}>
                    <button type="button" className={styles.secondaryBtn} onClick={() => handleReportAction(rep._id, 'dismiss')}>Dismiss</button>
                    <button type="button" className={styles.secondaryBtn} onClick={() => handleReportAction(rep._id, 'ban')}>Ban</button>
                    <button type="button" className={styles.secondaryBtn} onClick={() => handleReportAction(rep._id, 'suspend')}>Suspend</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {tab === 'audit' && (
          <ul style={{ maxHeight: '260px', overflowY: 'auto', listStyle: 'none', padding: 0, fontSize: '0.8rem' }}>
            {audits.map((a) => (
              <li key={a._id} style={{ padding: '0.3rem 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <code>{a.action}</code> — {new Date(a.at).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
