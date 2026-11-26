import { useRef, useState } from 'react';
import { apiFetch } from '../api/client.js';
import styles from './MessageInput.module.css';

const MAX_LENGTH = 2000;
const MAX_ATTACHMENTS = 4;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
]);

function uploadWithProgress(uploadUrl, file, onProgress, onXhrReady) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onXhrReady?.(xhr);

    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(file);
  });
}

export default function MessageInput({
  roomId,
  onSend,
  onTyping,
  onStopTyping,
  disabled,
  roomLabel = '#General',
}) {
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState([]);
  const [uploadError, setUploadError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  async function startUpload(entry) {
    setUploads((prev) =>
      prev.map((u) => (u.id === entry.id ? { ...u, status: 'uploading', progress: 0, error: '' } : u))
    );

    try {
      const presigned = await apiFetch('/api/uploads/presign', {
        method: 'POST',
        body: JSON.stringify({
          roomId,
          filename: entry.file.name,
          contentType: entry.file.type,
          size: entry.file.size,
        }),
      });

      await uploadWithProgress(
        presigned.uploadUrl,
        entry.file,
        (progress) => {
          setUploads((prev) => prev.map((u) => (u.id === entry.id ? { ...u, progress } : u)));
        },
        (xhr) => {
          setUploads((prev) => prev.map((u) => (u.id === entry.id ? { ...u, xhr } : u)));
        }
      );

      setUploads((prev) =>
        prev.map((u) =>
          u.id === entry.id
            ? {
                ...u,
                status: 'ready',
                progress: 100,
                key: presigned.key,
                xhr: null,
              }
            : u
        )
      );
    } catch (err) {
      setUploads((prev) =>
        prev.map((u) =>
          u.id === entry.id
            ? { ...u, status: 'error', error: err.message || 'Upload failed', xhr: null }
            : u
        )
      );
    }
  }

  function handleFiles(fileList) {
    if (!roomId || disabled) return;
    setUploadError('');

    const incoming = Array.from(fileList || []);
    if (uploads.length + incoming.length > MAX_ATTACHMENTS) {
      setUploadError(`You can attach up to ${MAX_ATTACHMENTS} files per message`);
      return;
    }

    const accepted = [];
    for (const file of incoming) {
      if (!ALLOWED_MIME_TYPES.has(file.type)) {
        setUploadError(`Unsupported file type: ${file.name} (allowed: PNG, JPG, WEBP, GIF, PDF, TXT)`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES || file.size === 0) {
        setUploadError(`${file.name} must be between 1 B and 10 MB`);
        continue;
      }
      const isImage = file.type.startsWith('image/');
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        name: file.name,
        contentType: file.type,
        size: file.size,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        status: 'uploading',
        progress: 0,
        key: null,
        error: '',
        xhr: null,
      };
      accepted.push(entry);
    }

    if (accepted.length > 0) {
      setUploads((prev) => [...prev, ...accepted]);
      accepted.forEach((entry) => startUpload(entry));
    }
  }

  function removeUpload(id) {
    setUploads((prev) => {
      const target = prev.find((u) => u.id === id);
      if (target?.xhr) target.xhr.abort();
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((u) => u.id !== id);
    });
  }

  const hasUploading = uploads.some((u) => u.status === 'uploading');
  const readyAttachments = uploads
    .filter((u) => u.status === 'ready' && u.key)
    .map((u) => ({
      key: u.key,
      name: u.name,
      contentType: u.contentType,
      size: u.size,
      previewUrl: u.previewUrl,
    }));

  function submit() {
    const trimmed = text.trim();
    if ((!trimmed && readyAttachments.length === 0) || hasUploading) return;
    onStopTyping();
    onSend(trimmed, readyAttachments);
    setText('');
    setUploads([]);
    setUploadError('');
  }

  function handleSubmit(e) {
    e.preventDefault();
    submit();
  }

  function handleChange(e) {
    const next = e.target.value;
    setText(next);
    if (next.trim().length > 0) {
      onTyping();
    } else {
      onStopTyping();
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handlePaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length > 0) {
      handleFiles(files);
    }
  }

  return (
    <div
      className={`${styles.composerWrap} ${isDragging ? styles.dragging : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      {uploadError && (
        <div className={styles.uploadError} role="alert">
          {uploadError}
        </div>
      )}

      {uploads.length > 0 && (
        <div className={styles.previews}>
          {uploads.map((u) => (
            <div key={u.id} className={styles.previewItem}>
              {u.previewUrl ? (
                <img src={u.previewUrl} alt={u.name} className={styles.thumb} />
              ) : (
                <span className={styles.fileBadge}>{u.name}</span>
              )}

              <div className={styles.previewMeta}>
                <span className={styles.previewName}>{u.name}</span>
                {u.status === 'uploading' && (
                  <div className={styles.progressBar}>
                    <div className={styles.progressFill} style={{ width: `${u.progress}%` }} />
                  </div>
                )}
                {u.status === 'error' && (
                  <div className={styles.previewErr}>
                    <span>{u.error}</span>
                    <button type="button" className={styles.retryUpload} onClick={() => startUpload(u)}>
                      Retry
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                className={styles.removePreview}
                onClick={() => removeUpload(u.id)}
                aria-label={`Remove ${u.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <form className={styles.form} onSubmit={handleSubmit}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          className={styles.attachBtn}
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploads.length >= MAX_ATTACHMENTS}
          aria-label="Attach files"
          title="Attach image, PDF, or TXT (max 10 MB)"
        >
          📎
        </button>

        <label htmlFor="message-composer" className={styles.srOnly}>
          Type a message
        </label>
        <textarea
          id="message-composer"
          className={styles.textarea}
          rows={1}
          maxLength={MAX_LENGTH}
          placeholder={`Message ${roomLabel} (Enter to send, Shift+Enter for newline)`}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={onStopTyping}
          disabled={disabled}
        />
        <button
          type="submit"
          className={styles.sendBtn}
          disabled={
            disabled || hasUploading || (text.trim().length === 0 && readyAttachments.length === 0)
          }
        >
          Send
        </button>
      </form>
    </div>
  );
}
