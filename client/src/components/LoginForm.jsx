import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import styles from './LoginForm.module.css';

const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

export default function LoginForm() {
  const { login, verifyMfa, register, signedOutNotice } = useAuth();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === 'register';

  function validate() {
    const trimmed = username.trim();
    if (!trimmed) {
      return 'Username is required';
    }
    if (isRegister && !USERNAME_REGEX.test(trimmed)) {
      return 'Username must be 3-20 characters (letters, numbers, underscores)';
    }
    if (!password) {
      return 'Password is required';
    }
    if (isRegister && password.length < 10) {
      return 'Password must be at least 10 characters';
    }
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError('');
    setSubmitting(true);
    try {
      if (isRegister) {
        await register(username.trim(), password);
      } else {
        const res = await login(username.trim(), password);
        if (res?.mfaRequired) {
          setMfaToken(res.mfaToken);
          setMfaCode('');
          setUseRecovery(false);
        }
      }
    } catch (err) {
      setError(err.message || 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaSubmit(e) {
    e.preventDefault();
    if (!mfaCode.trim()) {
      setError(useRecovery ? 'Enter a recovery code' : 'Enter your 6-digit code');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      await verifyMfa(
        useRecovery
          ? { mfaToken, recoveryCode: mfaCode.trim() }
          : { mfaToken, code: mfaCode.trim() }
      );
    } catch (err) {
      setError(err.message || 'Verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  function toggleMode() {
    setMode((prev) => (prev === 'login' ? 'register' : 'login'));
    setError('');
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="auth-heading">
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            #
          </span>
          <div>
            <h1 id="auth-heading" className={styles.title}>
              {isRegister ? 'Create your account' : 'Sign in to PulseChat'}
            </h1>
            <p className={styles.subtitle}>
              {isRegister ? 'Join the global room in seconds' : 'Welcome back to the conversation'}
            </p>
          </div>
        </div>

        {signedOutNotice && (
          <div className={styles.notice} role="status" aria-live="polite">
            {signedOutNotice}
          </div>
        )}

        {mfaToken ? (
          <form className={styles.form} onSubmit={handleMfaSubmit} noValidate>
            <div className={styles.field}>
              <label htmlFor="mfa-code" className={styles.label}>
                {useRecovery ? 'Recovery code' : 'Authenticator 6-digit code'}
              </label>
              <input
                id="mfa-code"
                type="text"
                className={styles.input}
                placeholder={useRecovery ? 'ABCD-1234' : '123456'}
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value)}
                disabled={submitting}
                autoFocus
                required
              />
            </div>

            {error && (
              <div className={styles.error} role="alert">
                {error}
              </div>
            )}

            <button type="submit" className={styles.submitBtn} disabled={submitting}>
              {submitting ? 'Verifying…' : 'Verify & Sign In'}
            </button>

            <div className={styles.footer}>
              <button
                type="button"
                className={styles.switchBtn}
                onClick={() => {
                  setUseRecovery((prev) => !prev);
                  setMfaCode('');
                  setError('');
                }}
              >
                {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
              </button>
              <button
                type="button"
                className={styles.switchBtn}
                onClick={() => {
                  setMfaToken('');
                  setMfaCode('');
                  setError('');
                }}
              >
                Back
              </button>
            </div>
          </form>
        ) : (
          <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label htmlFor="username" className={styles.label}>
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              className={styles.input}
              placeholder="alex_dev"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
              required
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="password" className={styles.label}>
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              className={styles.input}
              placeholder={isRegister ? 'At least 10 characters' : 'Enter your password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              required
            />
          </div>

          {error && (
            <div className={styles.error} role="alert">
              {error}
            </div>
          )}

          <button type="submit" className={styles.submitBtn} disabled={submitting}>
            {submitting
              ? isRegister
                ? 'Creating account…'
                : 'Signing in…'
              : isRegister
                ? 'Create Account'
                : 'Sign In'}
          </button>
        </form>
        )}

        <div className={styles.footer}>
          <span>{isRegister ? 'Already have an account?' : "Don't have an account?"}</span>
          <button type="button" className={styles.switchBtn} onClick={toggleMode} disabled={submitting}>
            {isRegister ? 'Sign in' : 'Register'}
          </button>
        </div>
      </section>
    </main>
  );
}
