function detectEnvironment() {
  if (process.env.KUBERNETES_SERVICE_HOST || process.env.KUBERNETES_PORT) {
    return 'kubernetes';
  }
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    return 'vercel';
  }
  if (process.env.NODE_ENV !== 'production' || 
      process.env.HOSTNAME === 'localhost' || 
      !process.env.KUBERNETES_SERVICE_HOST) {
    return 'localhost';
  }
  return 'unknown';
}

async function getApiKeys() {
  try {
    const environment = detectEnvironment();
    const azureStorageKey = process.env.azure_storage_key || null;
    const azureTtsKey = process.env.azure_tts_key || null;
    const elevenlabsTtsKey = process.env.elevenlabs_tts_key || null;

    if (azureStorageKey || azureTtsKey || elevenlabsTtsKey) {
      return {
        azureStorageKey,
        ttsApiKey: azureTtsKey,
        elevenlabsTtsKey,
        source: environment
      };
    }

    return null;
  } catch (error) {
    console.error('Error retrieving API keys:', error);
    return null;
  }
}

module.exports = {
  detectEnvironment,
  getApiKeys
};

