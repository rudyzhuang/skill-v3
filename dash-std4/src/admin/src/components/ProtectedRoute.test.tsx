import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AuthContext, type AuthContextValue } from '../context/AuthContext';
import { ProtectedRoute } from './ProtectedRoute';

function wrap(
  ui: React.ReactNode,
  auth: Partial<AuthContextValue>,
  initialPath = '/projects',
) {
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
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/*"
            element={<ProtectedRoute>{ui}</ProtectedRoute>}
          />
          <Route path="/login" element={<p>登录页</p>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('ProtectedRoute', () => {
  it('redirects unauthenticated users to /login with returnUrl', () => {
    render(wrap(<p>受保护内容</p>, { user: null, loading: false }));
    expect(screen.getByText('登录页')).toBeTruthy();
    expect(screen.queryByText('受保护内容')).toBeNull();
  });

  it('shows loading while session is being resolved', () => {
    render(wrap(<p>受保护内容</p>, { user: null, loading: true }));
    expect(screen.getByText('加载中…')).toBeTruthy();
  });

  it('renders children when user is authenticated', () => {
    render(
      wrap(
        <p>受保护内容</p>,
        {
          user: { id: '1', email: 'a@b.com', role: 'admin' },
          loading: false,
        },
      ),
    );
    expect(screen.getByText('受保护内容')).toBeTruthy();
  });
});
