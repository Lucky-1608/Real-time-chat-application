import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import Modal from './Modal.jsx';
import styles from './SecuritySettingsModal.module.css';

function formatDate(iso) {
  if (!iso) return 'Unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString();
}

export default function SecuritySettingsModal({ isOpen, onClose }) {
  const { logout } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/api/auth/sessions');
      setSessions(data.sessions || []);
    } catch (err) {
      setError(err.message || 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadSessions();
    } else {
      setConfirmTarget(null);
      setError('');
    }
  }, [isOpen, loadSessions]);

  async function handleRevokeOne(session) {
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/auth/sessions/${session.id}`, { method: 'DELETE' });
      setConfirmTarget(null);
      if (session.isCurrent) {
        await logout();
        return;
      }
      await loadSessions();
    } catch (err) {
      setError(err.message || 'Failed to revoke session');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogoutOthers() {
    setBusy(true);
    setError('');
    try {
      await apiFetch('/api/auth/logout-all', {
        method: 'POST',
        body: JSON.stringify({ keepCurrent: true }),
      });
      setConfirmTarget(null);
      await loadSessions();
    } catch (err) {
      setError(err.message || 'Failed to log out other sessions');
    } finally {
      setBusy(false);
    }
  }

  const otherCount = sessions.filter((s) => !s.isCurrent).length;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Settings › Security">
      <div className={styles.wrap}>
        <div className={styles.topRow}>
          <p className={styles.subtitle}>Active sessions for your account</p>
          {otherCount > 0 && confirmTarget !== 'all-others' && (
            <button
              type="button"
              className={styles.dangerOutlineBtn}
              onClick={() => setConfirmTarget('all-others')}
              disabled={busy}
            >
              Log out everywhere else
            </button>
          )}
        </div>

        {confirmTarget === 'all-others' && (
          <div className={styles.confirmBox} role="alert">
            <span>Sign out {otherCount} other device(s)?</span>
            <div className={styles.confirmBtns}>
              <button
                type="button"
                className={styles.dangerBtn}
                onClick={handleLogoutOthers}
                disabled={busy}
              >
                Confirm
              </button>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={() => setConfirmTarget(null)}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <p className={styles.empty}>Loading active sessions…</p>
        ) : sessions.length === 0 ? (
          <p className={styles.empty}>No active sessions found</p>
        ) : (
          <ul className={styles.list}>
            {sessions.map((s) => (
              <li key={s.id} className={styles.item}>
                <div className={styles.itemInfo}>
                  <div className={styles.deviceRow}>
                    <span className={styles.deviceName}>{s.device}</span>
                    {s.isCurrent && <span className={styles.currentBadge}>This device</span>}
                  </div>
                  <span className={styles.meta}>
                    IP: {s.ip} · Last active: {formatDate(s.lastActiveAt)}
                  </span>
                  <span className={styles.meta}>Signed in: {formatDate(s.createdAt)}</span>
                </div>

                {confirmTarget === s.id ? (
                  <div className={styles.confirmBtns}>
                    <button
                      type="button"
                      className={styles.dangerBtn}
                      onClick={() => handleRevokeOne(s)}
                      disabled={busy}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      className={styles.cancelBtn}
                      onClick={() => setConfirmTarget(null)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.revokeBtn}
                    onClick={() => setConfirmTarget(s.id)}
                    disabled={busy}
                  >
                    Log out this device
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
