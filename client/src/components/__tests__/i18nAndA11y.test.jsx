// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n, { changeLanguage, formatLocalizedNumber } from '../../i18n.js';
import RoomHeader from '../RoomHeader.jsx';

describe('Sub-phase 9.6: i18n Language Switching & Accessibility', () => {
  it('switches UI language between English, Hindi, and pseudo-locale without page reload', async () => {
    await changeLanguage('en');
    const room = {
      _id: '507f1f77bcf86cd799439011',
      name: 'General',
      type: 'public',
      members: [{ user: { id: 'u1', username: 'Alice' }, role: 'member' }],
    };

    render(
      <I18nextProvider i18n={i18n}>
        <RoomHeader
          room={room}
          currentUser={{ id: 'u1', username: 'Alice' }}
          onlineUserIds={new Set(['u1'])}
          onlineCount={1}
          onOpenRoomsDrawer={() => {}}
          onOpenUsersDrawer={() => {}}
          onOpenSecurity={() => {}}
          onLogout={() => {}}
        />
      </I18nextProvider>
    );

    expect(screen.getByText('Sign out')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'hi' } });
    expect(screen.getByText('साइन आउट')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('भाषा'), { target: { value: 'pseudo' } });
    expect(screen.getByText(/\[!! Siign oouut !!\]/i)).toBeTruthy();

    expect(formatLocalizedNumber(1234, 'en')).toBe('1,234');
    await changeLanguage('en');
  });
});
