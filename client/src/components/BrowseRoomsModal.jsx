import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client.js';
import Modal from './Modal.jsx';
import styles from './RoomModals.module.css';

export default function BrowseRoomsModal({ isOpen, onClose, onJoinRoom }) {
  const [query, setQuery] = useState('');
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setRooms([]);
      setError('');
      return undefined;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await apiFetch(`/api/rooms/public?q=${encodeURIComponent(query.trim())}`);
        setRooms(data.rooms || []);
      } catch (err) {
        setError(err.message || 'Failed to load public rooms');
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [isOpen, query]);

  async function handleJoin(roomId) {
    setError('');
    setJoiningId(roomId);
    try {
      await onJoinRoom(roomId);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to join room');
    } finally {
      setJoiningId(null);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Browse public rooms">
      <div className={styles.form}>
        <div className={styles.field}>
          <label htmlFor="browse-rooms-search" className={styles.label}>
            Search rooms
          </label>
          <input
            id="browse-rooms-search"
            className={styles.input}
            placeholder="Filter public rooms…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <p className={styles.empty}>Loading rooms…</p>
        ) : rooms.length === 0 ? (
          <p className={styles.empty}>No unjoined public rooms found</p>
        ) : (
          <ul className={styles.resultsList}>
            {rooms.map((room) => (
              <li key={room._id} className={styles.resultItem}>
                <span>
                  # {room.name} ({room.members?.length || 0})
                </span>
                <button
                  type="button"
                  className={styles.smallBtn}
                  disabled={joiningId === room._id}
                  onClick={() => handleJoin(room._id)}
                >
                  {joiningId === room._id ? 'Joining…' : 'Join'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
