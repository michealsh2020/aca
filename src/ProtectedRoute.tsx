import React, { useState } from 'react';
import { useMsal } from '@azure/msal-react';
import { useAuth } from './authContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * ProtectedRoute component that ensures user is authenticated before rendering children
 */
export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { inProgress } = useMsal();
  const { isAuthenticated, login } = useAuth();
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    try {
      await login();
    } catch (error) {
      console.error('Login error:', error);
    } finally {
      setIsLoggingIn(false);
    }
  };

  if (inProgress !== 'none') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-gray-700 mb-4"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background relative">
        <div className="absolute top-6 left-6">
          <img 
            src="/skillsoft-logo.png" 
            alt="Skillsoft" 
            className="h-8 w-auto"
          />
        </div>
        <div className="text-center max-w-md mx-auto p-8 bg-white rounded-xl shadow-xl">
          <h1 className="text-2xl font-bold text-foreground mb-4">Sign In Required</h1>
          <p className="text-gray-600 mb-6">
            You need to sign in with your Microsoft account to access the Lexicon Editor.
          </p>
          <button
            onClick={handleLogin}
            disabled={isLoggingIn || inProgress !== 'none'}
            className="px-6 py-3 bg-gray-700 text-white font-medium rounded-lg hover:bg-gray-800 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 min-w-[160px] mx-auto"
          >
            {isLoggingIn || inProgress !== 'none' ? (
              <>
                <div className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                <span>Signing in...</span>
              </>
            ) : (
              'Sign in with SSO'
            )}
          </button>
          {isLoggingIn && (
            <p className="text-sm text-gray-500 mt-4">
              Redirecting to Microsoft login...
            </p>
          )}
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

