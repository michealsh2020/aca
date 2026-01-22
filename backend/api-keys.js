async function getApiKeys() {
  try {
    const azureStorageKey = process.env.azure_storage_key || null;
    const azureTtsKey = process.env.azure_tts_key || null;
    const elevenlabsTtsKey = process.env.elevenlabs_tts_key || null;

    if (azureStorageKey || azureTtsKey || elevenlabsTtsKey) {
      return {
        azureStorageKey,
        ttsApiKey: azureTtsKey,
        elevenlabsTtsKey,
        source: 'environment'
      };
    }

    return null;
  } catch (error) {
    console.error('Error retrieving API keys:', error);
    return null;
  }
}

module.exports = {
  getApiKeys
};

