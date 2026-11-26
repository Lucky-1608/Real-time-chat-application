import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import LoginForm from './components/LoginForm.jsx';
import ChatWindow from './components/ChatWindow.jsx';

function AppContent() {
  const { isAuthenticated, initializing } = useAuth();
  if (initializing) {
    return null;
  }
  return isAuthenticated ? <ChatWindow /> : <LoginForm />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
