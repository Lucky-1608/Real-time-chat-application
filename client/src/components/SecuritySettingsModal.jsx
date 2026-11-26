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
  const { user, logout, updateUser } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [busy, setBusy] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwStatus, setPwStatus] = useState({ error: '', success: '' });
  const [changingPw, setChangingPw] = useState(false);

  const [mfaSetup, setMfaSetup] = useState(null);
  const [mfaCode, setMfaCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [disablePw, setDisablePw] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [mfaStatus, setMfaStatus] = useState({ error: '', success: '' });

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
      setCurrentPassword('');
      setNewPassword('');
      setPwStatus({ error: '', success: '' });
      setMfaSetup(null);
      setMfaCode('');
      setRecoveryCodes(null);
      setDisablePw('');
      setDisableCode('');
      setMfaStatus({ error: '', success: '' });
    }
  }, [isOpen, loadSessions]);

  async function handleStart2fa() {
    setMfaStatus({ error: '', success: '' });
    try {
      const data = await apiFetch('/api/auth/2fa/setup', { method: 'POST' });
      setMfaSetup(data);
    } catch (err) {
      setMfaStatus({ error: err.message || 'Failed to start 2FA setup', success: '' });
    }
  }

  async function handleEnable2fa(e) {
    e.preventDefault();
    setMfaStatus({ error: '', success: '' });
    try {
      const data = await apiFetch('/api/auth/2fa/enable', {
        method: 'POST',
        body: JSON.stringify({ code: mfaCode.trim() }),
      });
      setRecoveryCodes(data.recoveryCodes || []);
      setMfaSetup(null);
      setMfaCode('');
      updateUser({ twoFactorEnabled: true });
      setMfaStatus({
        error: '',
        success: '2FA enabled. Save these recovery codes somewhere safe—they are shown once.',
      });
    } catch (err) {
      setMfaStatus({ error: err.message || 'Failed to enable 2FA', success: '' });
    }
  }

  async function handleDisable2fa(e) {
    e.preventDefault();
    setMfaStatus({ error: '', success: '' });
    try {
      await apiFetch('/api/auth/2fa/disable', {
        method: 'POST',
        body: JSON.stringify({ password: disablePw, code: disableCode.trim() }),
      });
      setDisablePw('');
      setDisableCode('');
      setRecoveryCodes(null);
      updateUser({ twoFactorEnabled: false });
      setMfaStatus({ error: '', success: 'Two-factor authentication disabled.' });
    } catch (err) {
      setMfaStatus({ error: err.message || 'Failed to disable 2FA', success: '' });
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    if (newPassword.length < 10) {
      setPwStatus({ error: 'New password must be at least 10 characters', success: '' });
      return;
    }
    setChangingPw(true);
    setPwStatus({ error: '', success: '' });
    try {
      await apiFetch('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setPwStatus({ error: '', success: 'Password updated and other devices signed out.' });
      await loadSessions();
    } catch (err) {
      setPwStatus({ error: err.message || 'Failed to change password', success: '' });
    } finally {
      setChangingPw(false);
    }
  }

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

        <form className={styles.pwSection} onSubmit={handleChangePassword}>
          <h3 className={styles.pwHeading}>Change password</h3>
          <input
            type="password"
            className={styles.pwInput}
            placeholder="Current password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
          <input
            type="password"
            className={styles.pwInput}
            placeholder="New password (min 10 characters)"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
          {pwStatus.error && (
            <div className={styles.error} role="alert">
              {pwStatus.error}
            </div>
          )}
          {pwStatus.success && (
            <div className={styles.success} role="status">
              {pwStatus.success}
            </div>
          )}
          <button type="submit" className={styles.pwBtn} disabled={changingPw}>
            {changingPw ? 'Updating…' : 'Update Password'}
          </button>
        </form>

        <div className={styles.pwSection}>
          <h3 className={styles.pwHeading}>Two-Factor Authentication (2FA)</h3>
          {mfaStatus.error && (
            <div className={styles.error} role="alert">
              {mfaStatus.error}
            </div>
          )}
          {mfaStatus.success && (
            <div className={styles.success} role="status">
              {mfaStatus.success}
            </div>
          )}

          {recoveryCodes && (
            <div className={styles.recoveryBox}>
              {recoveryCodes.map((c) => (
                <code key={c} className={styles.recoveryCode}>
                  {c}
                </code>
              ))}
            </div>
          )}

          {!user?.twoFactorEnabled ? (
            mfaSetup ? (
              <form className={styles.pwSection} onSubmit={handleEnable2fa}>
                <img src={mfaSetup.qrDataUrl} alt="2FA QR Code" className={styles.qrImg} />
                <span className={styles.meta}>Secret: {mfaSetup.secret}</span>
                <input
                  type="text"
                  className={styles.pwInput}
                  placeholder="Enter 6-digit code to confirm"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  required
                />
                <button type="submit" className={styles.pwBtn}>
                  Verify & Enable 2FA
                </button>
              </form>
            ) : (
              <button type="button" className={styles.pwBtn} onClick={handleStart2fa}>
                Enable 2FA
              </button>
            )
          ) : (
            <form className={styles.pwSection} onSubmit={handleDisable2fa}>
              <input
                type="password"
                className={styles.pwInput}
                placeholder="Current password"
                value={disablePw}
                onChange={(e) => setDisablePw(e.target.value)}
                required
              />
              <input
                type="text"
                className={styles.pwInput}
                placeholder="Current 6-digit code"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                required
              />
              <button type="submit" className={styles.dangerBtn}>
                Disable 2FA
              </button>
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}
