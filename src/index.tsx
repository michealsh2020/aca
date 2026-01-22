import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { Buffer } from 'buffer';
import { PublicClientApplication } from '@azure/msal-browser';
import { MsalProvider } from '@azure/msal-react';
import { msalConfig } from './authConfig';
import { AuthProvider } from './authContext';
window.Buffer = Buffer;

// Create MSAL instance
const msalInstance = new PublicClientApplication(msalConfig);

// Initialize MSAL
msalInstance.initialize().then(() => {
  // Handle redirect promise on initial load - this processes the token when redirecting back from Microsoft login
  msalInstance.handleRedirectPromise().then((response) => {
    if (response) {
      console.log('Redirect authentication successful:', response.account);
    }
  }).catch((error) => {
    // Ignore empty navigation errors (normal when not coming from redirect)
    if (error.errorCode !== 'empty_navigation_uris') {
      console.error('Redirect error:', error);
    }
  });

  const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
  );
  root.render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MsalProvider>
    </React.StrictMode>
  );
});

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
