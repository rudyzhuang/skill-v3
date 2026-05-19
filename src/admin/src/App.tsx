import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppHeader } from './components/AppHeader';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { ProjectListPage } from './pages/ProjectListPage';
import { ProjectDashboardPage } from './pages/ProjectDashboardPage';

function AppLayout() {
  return (
    <>
      <AppHeader />
      <Routes>
        <Route path="/" element={<ProjectListPage />} />
        <Route path="/projects" element={<ProjectListPage />} />
        <Route
          path="/projects/:projectId/dashboard"
          element={<ProjectDashboardPage />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
