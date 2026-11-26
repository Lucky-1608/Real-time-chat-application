import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';
import Modal from './Modal.jsx';
import styles from './RoomModals.module.css';

export default function InviteMembersModal({ isOpen, onClose, room, onInvite }) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [invitingId, setInvitingId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setUsers([]);
      setError('');
      return undefined;
    }

    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch(`/api/users?q=${encodeURIComponent(query.trim())}`);
        const memberIds = new Set((room?.members || []).map((m) => m.user?.id));
        setUsers((data.users || []).filter((u) => !memberIds.has(u.id)));
      } catch {
        setUsers([]);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [isOpen, query, room]);

  async function handleInvite(userId) {
    if (!room?._id) return;
    setError('');
    setInvitingId(userId);
    try {
      await onInvite(room._id, [userId]);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch (err) {
      setError(err.message || 'Failed to invite user');
    } finally {
      setInvitingId(null);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Invite to ${room?.name || 'room'}`}>
      <div className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="invite-member-search" className={styles.label}>
            Search users
          </label>
          <input
            id="invite-member-search"
            className={styles.input}
            placeholder="Search by username…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        {users.length === 0 ? (
          <p className={styles.empty}>No matching users to invite</p>
        ) : (
          <ul className={styles.resultsList}>
            {users.map((u) => (
              <li key={u.id} className={styles.resultItem}>
                <span>{u.username}</span>
                <button
                  type="button"
                  className={styles.smallBtn}
                  disabled={invitingId === u.id}
                  onClick={() => handleInvite(u.id)}
                >
                  {invitingId === u.id ? 'Inviting…' : 'Invite'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
