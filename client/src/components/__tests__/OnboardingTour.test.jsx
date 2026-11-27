// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import OnboardingTour from '../OnboardingTour.jsx';

describe('OnboardingTour', () => {
  it('renders step progress, supports Next/Back/Skip/Demo actions, and handles Escape', () => {
    const onStepChange = vi.fn();
    const onSkip = vi.fn();
    const onAddDemoContent = vi.fn();
    const onRemoveDemoContent = vi.fn();

    const { rerender } = render(
      <OnboardingTour
        isOpen
        onboarding={{ tourStep: 0 }}
        hasDemoRoom={false}
        demoLoading={false}
        onStepChange={onStepChange}
        onComplete={vi.fn()}
        onSkip={onSkip}
        onOpenCreateRoom={vi.fn()}
        onAddDemoContent={onAddDemoContent}
        onRemoveDemoContent={onRemoveDemoContent}
      />
    );

    expect(screen.getByRole('region', { name: 'Getting started tour' })).toBeTruthy();
    expect(screen.getByText('Getting Started (1 / 4)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onStepChange).toHaveBeenCalledWith(1, 'create_room');

    fireEvent.click(screen.getByRole('button', { name: 'Add demo content' }));
    expect(onAddDemoContent).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onSkip).toHaveBeenCalledTimes(1);

    rerender(
      <OnboardingTour
        isOpen
        onboarding={{ tourStep: 3 }}
        hasDemoRoom
        demoLoading={false}
        onStepChange={onStepChange}
        onComplete={vi.fn()}
        onSkip={onSkip}
        onOpenCreateRoom={vi.fn()}
        onAddDemoContent={onAddDemoContent}
        onRemoveDemoContent={onRemoveDemoContent}
      />
    );

    expect(screen.getByRole('button', { name: 'Remove demo content' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Finish tour' })).toBeTruthy();
  });
});
