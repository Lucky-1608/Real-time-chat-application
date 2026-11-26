import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';
import Modal from './Modal.jsx';
import styles from './RoomModals.module.css';

export default function CreateRoomModal({ isOpen, onClose, onCreateRoom }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('public');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setName('');
      setType('public');
      setQuery('');
      setResults([]);
      setSelectedUsers([]);
      setError('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || type !== 'private') return undefined;
    const timer = setTimeout(async () => {
      try {
        const data = await apiFetch(`/api/users?q=${encodeURIComponent(query.trim())}`);
        setResults(data.users || []);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [isOpen, type, query]);

  function addMember(u) {
    setSelectedUsers((prev) => (prev.some((x) => x.id === u.id) ? prev : [...prev, u]));
  }

  function removeMember(id) {
    setSelectedUsers((prev) => prev.filter((x) => x.id !== id));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 3 || trimmed.length > 30) {
      setError('Room name must be 3-30 characters');
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      await onCreateRoom({
        name: trimmed,
        type,
        memberIds: type === 'private' ? selectedUsers.map((u) => u.id) : [],
      });
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create room');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create a room">
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.field}>
          <label htmlFor="create-room-name" className={styles.label}>
            Room name
          </label>
          <input
            id="create-room-name"
            className={styles.input}
            placeholder="e.g. design-team"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            required
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Visibility</span>
          <div className={styles.toggleRow}>
            <button
              type="button"
              className={`${styles.toggleBtn} ${type === 'public' ? styles.toggleActive : ''}`}
              onClick={() => setType('public')}
            >
              Public
            </button>
            <button
              type="button"
              className={`${styles.toggleBtn} ${type === 'private' ? styles.toggleActive : ''}`}
              onClick={() => setType('private')}
            >
              Private
            </button>
          </div>
        </div>

        {type === 'private' && (
          <div className={styles.field}>
            <label htmlFor="invite-search" className={styles.label}>
              Invite members (optional)
            </label>
            {selectedUsers.length > 0 && (
              <div className={styles.chips}>
                {selectedUsers.map((u) => (
                  <span key={u.id} className={styles.chip}>
                    {u.username}
                    <button
                      type="button"
                      className={styles.chipRemove}
                      onClick={() => removeMember(u.id)}
                      aria-label={`Remove ${u.username}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              id="invite-search"
              className={styles.input}
              placeholder="Search users by username…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {results.length === 0 ? (
              <p className={styles.empty}>No matching users</p>
            ) : (
              <ul className={styles.resultsList}>
                {results.map((u) => {
                  const isAdded = selectedUsers.some((x) => x.id === u.id);
                  return (
                    <li key={u.id} className={styles.resultItem}>
                      <span>{u.username}</span>
                      <button
                        type="button"
                        className={styles.smallBtn}
                        disabled={isAdded}
                        onClick={() => addMember(u)}
                      >
                        {isAdded ? 'Added' : 'Add'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        <button type="submit" className={styles.submitBtn} disabled={submitting}>
          {submitting ? 'Creating…' : 'Create Room'}
        </button>
      </form>
    </Modal>
  );
}
