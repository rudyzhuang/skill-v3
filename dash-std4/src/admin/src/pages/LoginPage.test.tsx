import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AuthContext, type AuthContextValue } from '../context/AuthContext';
import { LoginPage } from './LoginPage';

function wrap(ui: React.ReactNode, auth: Partial<AuthContextValue> = {}) {
  const value: AuthContextValue = {
    user: null,
    loading: false,
    login: async () => {},
    logout: async () => {},
    refreshMe: async () => {},
    ...auth,
  };
  return (
    <AuthContext.Provider value={value}>
      <MemoryRouter>{ui}</MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('LoginPage', () => {
  it('renders email, password fields and login button', () => {
    render(wrap(<LoginPage />));
    expect(screen.getByLabelText(/邮箱或用户名/)).toBeTruthy();
    expect(screen.getByLabelText(/密码/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('does not show default account hints', () => {
    render(wrap(<LoginPage />));
    expect(screen.queryByText(/默认账号/)).toBeNull();
    expect(screen.queryByText(/ADMIN_PASSWORD/)).toBeNull();
    expect(screen.queryByText(/ADMIN_EMAIL/)).toBeNull();
  });
});
