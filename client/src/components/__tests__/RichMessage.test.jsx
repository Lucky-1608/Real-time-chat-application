// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import RichMessageText from '../RichMessageText.jsx';

describe('Sub-phase 9.3: RichMessageText XSS Sanitization', () => {
  it('renders XSS payloads inert and enforces safe link attributes', () => {
    const malicious = [
      '<script>alert("xss")</script>',
      '[Click me](javascript:alert(1))',
      '<img src="x" onerror="alert(1)" />',
      '![img](javascript:alert(2))',
      '[Safe Link](https://example.com)',
    ].join('\n\n');

    const { container } = render(<RichMessageText text={malicious} />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.innerHTML).not.toContain('javascript:');

    const safeLink = container.querySelector('a[href="https://example.com"]');
    expect(safeLink).not.toBeNull();
    expect(safeLink.getAttribute('target')).toBe('_blank');
    expect(safeLink.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });
});
