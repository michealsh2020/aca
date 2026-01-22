import React, { createContext, useContext, ReactNode } from 'react';
import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { AccountInfo, AuthenticationResult } from '@azure/msal-browser';

interface AuthContextType {
  account: AccountInfo | null;
  isAuthenticated: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const { instance, accounts } = useMsal();
  const account = accounts.length > 0 ? accounts[0] : null;
  const isAuthenticated = useIsAuthenticated();

  const login = async () => {
    try {
      // Use standard redirect flow - simplest and most reliable
      await instance.loginRedirect({
        scopes: ['User.Read'],
        prompt: 'select_account',
      });
      // Note: loginRedirect will redirect the page, so code below won't execute
    } catch (error: any) {
      // User might have cancelled - don't show error for that
      if (error.errorCode !== 'user_cancelled' && error.message !== 'user_cancelled' && error.errorCode !== 'consent_required') {
        console.error('Login failed:', error);
      }
      throw error;
    }
  };

  const logout = async () => {
    try {
      await instance.logoutRedirect({
        account: account || undefined,
      });
    } catch (error) {
      console.error('Logout failed:', error);
      throw error;
    }
  };

  const getAccessToken = async (): Promise<string | null> => {
    if (!account) {
      return null;
    }

    try {
      const response: AuthenticationResult = await instance.acquireTokenSilent({
        scopes: ['User.Read'],
        account: account,
      });
      return response.accessToken;
    } catch (error) {
      console.error('Failed to acquire token silently:', error);
      // Try interactive acquisition via redirect
      try {
        await instance.acquireTokenRedirect({
          scopes: ['User.Read'],
          account: account,
        });
        // Note: acquireTokenRedirect will redirect, so this won't return
        return null;
      } catch (redirectError) {
        console.error('Failed to acquire token via redirect:', redirectError);
        return null;
      }
    }
  };

  const value: AuthContextType = {
    account,
    isAuthenticated,
    login,
    logout,
    getAccessToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
