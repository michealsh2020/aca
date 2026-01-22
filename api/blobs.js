const { BlobServiceClient } = require('@azure/storage-blob');

async function getApiKeys() {
  const azureStorageKey = process.env.azure_storage_key || null;
  return {
    azureStorageKey,
    source: 'environment'
  };
}

async function getAzureStorageKey() {
  const apiKeys = await getApiKeys();
  return apiKeys?.azureStorageKey || null;
}

function getConnectionString(accountKey) {
  if (!accountKey) {
    throw new Error('Azure Storage key not configured in environment variables');
  }
  return `DefaultEndpointsProtocol=https;AccountName=skillsoftlexicons;AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
}

const CONTAINER_NAME = 'lexicons';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-api-key'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const accountKey = await getAzureStorageKey();
  if (!accountKey) {
    return res.status(401).json({ error: 'API key not configured. Please set azure_storage_key environment variable.' });
  }

  try {
    const connectionString = getConnectionString(accountKey);
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blobNames = [];
    for await (const blob of containerClient.listBlobsFlat()) {
      blobNames.push(blob.name);
    }
    
    const filteredBlobs = blobNames.filter(blobName => !blobName.startsWith('deleted/'));
    res.json(filteredBlobs);
  } catch (err) {
    console.error('Error listing blobs:', err);
    res.status(500).json({ error: err.message });
  }
}; 