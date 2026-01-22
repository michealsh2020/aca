import { Configuration, RedirectRequest } from '@azure/msal-browser';

/**
 * Configuration object to be passed to MSAL instance on creation. 
 * For a full list of MSAL.js configuration parameters, visit:
 * https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/configuration.md 
 */
export const msalConfig: Configuration = {
  auth: {
    clientId: '0a0dccee-bf6c-4cfb-8ada-dbfc01518863',
    authority: 'https://login.microsoftonline.com/50361608-aa23-494d-a233-2fd14d6a03f4',
    // Get redirect URI based on environment
    redirectUri: typeof window !== 'undefined' ? getRedirectUri() : '/',
  },
  cache: {
    cacheLocation: 'sessionStorage', // This configures where your cache will be stored
    storeAuthStateInCookie: false, // Set this to "true" if you are having issues on IE11 or Edge
  },
  system: {
    windowHashTimeout: 60000,
    iframeHashTimeout: 6000,
    loadFrameTimeout: 0,
  },
};

/**
 * Scopes you add here will be prompted for user consent during sign-in.
 * By default, MSAL.js will add OIDC scopes (openid, profile, email) to any login request.
 * For more information about OIDC scopes, visit: 
 * https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-permissions-and-consent#openid-connect-scopes
 */
export const loginRequest: RedirectRequest = {
  scopes: ['User.Read'],
};

/**
 * Get redirect URI based on the current environment
 * Dynamically determines the redirect URI based on where the app is running
 */
function getRedirectUri(): string {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    const protocol = window.location.protocol;
    const port = window.location.port;
    
    // Localhost - use current URL (now whitelisted in Azure AD)
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      const portStr = port ? `:${port}` : ':3000'; // Default to 3000 if no port specified
      return `${protocol}//${hostname}${portStr}`;
    }
    
    // Kubernetes environment - use actual URL
    if (hostname.includes('web-lexicon-editor-content-development.dev.eastus.aks.skillsoft.com')) {
      return 'https://web-lexicon-editor-content-development.dev.eastus.aks.skillsoft.com';
    }
    
    // Vercel - use current URL (if whitelisted)
    if (hostname.includes('vercel.app')) {
      return `${protocol}//${hostname}`;
    }
    
    // Default fallback - use current URL
    return `${protocol}//${hostname}${port ? `:${port}` : ''}`;
  }
  
  // Default fallback for server-side
  return 'https://web-lexicon-editor-content-development.dev.eastus.aks.skillsoft.com';
}
