import { useEffect } from 'react';

const TOUR_STEPS = [
  {
    key: 'create_room',
    title: '1. Create a room',
    description:
      'Organize conversations by topic. Click "+" next to Rooms in the sidebar or use the button below.',
    actionLabel: 'Create a room',
  },
  {
    key: 'send_message',
    title: '2. Send a message',
    description:
      'Pick #General or #random and type your first message in the composer below.',
  },
  {
    key: 'invite_someone',
    title: '3. Invite someone',
    description:
      'Collaborate by inviting teammates to your workspace or private rooms.',
  },
  {
    key: 'try_slash_command',
    title: '4. Try a slash command',
    description:
      'Soon you can run /poll, /remind, or /summarize right from the composer. Want sample data to explore first?',
  },
];

export default function OnboardingTour({
  isOpen,
  onboarding,
  hasDemoRoom,
  demoLoading,
  onStepChange,
  onComplete,
  onSkip,
  onOpenCreateRoom,
  onAddDemoContent,
  onRemoveDemoContent,
}) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onSkip?.();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onSkip]);

  if (!isOpen) return null;

  const stepIndex = Math.min(Math.max(onboarding?.tourStep || 0, 0), TOUR_STEPS.length - 1);
  const step = TOUR_STEPS[stepIndex];
  const isLast = stepIndex === TOUR_STEPS.length - 1;

  return (
    <aside
      role="region"
      aria-label="Getting started tour"
      style={{
        position: 'fixed',
        bottom: '1rem',
        right: '1rem',
        width: 'min(360px, calc(100vw - 2rem))',
        background: '#0f172a',
        color: '#f8fafc',
        border: '1px solid #334155',
        borderRadius: '12px',
        padding: '1rem',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.45)',
        zIndex: 60,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.5rem',
        }}
      >
        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#7dd3fc' }}>
          Getting Started ({stepIndex + 1} / {TOUR_STEPS.length})
        </span>
        <button
          type="button"
          onClick={onSkip}
          aria-label="Skip onboarding tour"
          style={{
            background: 'transparent',
            color: '#cbd5e1',
            border: '1px solid #475569',
            borderRadius: '6px',
            padding: '0.2rem 0.5rem',
            fontSize: '0.75rem',
            cursor: 'pointer',
          }}
        >
          Skip
        </button>
      </div>

      <div aria-live="polite">
        <h2 style={{ margin: '0 0 0.35rem', fontSize: '1rem', color: '#ffffff' }}>{step.title}</h2>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: '#e2e8f0', lineHeight: 1.4 }}>
          {step.description}
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.75rem' }}>
        {step.actionLabel && onOpenCreateRoom && (
          <button
            type="button"
            onClick={onOpenCreateRoom}
            style={{
              background: '#0369a1',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              padding: '0.35rem 0.7rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {step.actionLabel}
          </button>
        )}

        {hasDemoRoom ? (
          <button
            type="button"
            disabled={demoLoading}
            onClick={onRemoveDemoContent}
            style={{
              background: '#991b1b',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              padding: '0.35rem 0.7rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {demoLoading ? 'Removing…' : 'Remove demo content'}
          </button>
        ) : (
          <button
            type="button"
            disabled={demoLoading}
            onClick={onAddDemoContent}
            style={{
              background: '#1e293b',
              color: '#f8fafc',
              border: '1px solid #475569',
              borderRadius: '6px',
              padding: '0.35rem 0.7rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {demoLoading ? 'Adding…' : 'Add demo content'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button
          type="button"
          disabled={stepIndex === 0}
          onClick={() => onStepChange?.(stepIndex - 1)}
          style={{
            background: '#1e293b',
            color: stepIndex === 0 ? '#64748b' : '#f8fafc',
            border: '1px solid #475569',
            borderRadius: '6px',
            padding: '0.35rem 0.75rem',
            fontSize: '0.8rem',
            cursor: stepIndex === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          Back
        </button>

        {isLast ? (
          <button
            type="button"
            onClick={onComplete}
            style={{
              background: '#047857',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              padding: '0.35rem 0.85rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Finish tour
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onStepChange?.(stepIndex + 1, step.key)}
            style={{
              background: '#0369a1',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              padding: '0.35rem 0.85rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Next
          </button>
        )}
      </div>
    </aside>
  );
}
