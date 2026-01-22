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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-api-key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const accountKey = await getAzureStorageKey();
  if (!accountKey) {
    return res.status(401).json({ error: 'API key not configured. Please set azure_storage_key environment variable.' });
  }

  try {
    const blobName = req.query.name;
    if (!blobName) {
      return res.status(400).json({ error: 'Blob name is required' });
    }

    const connectionString = getConnectionString(accountKey);
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blobClient = containerClient.getBlobClient(decodeURIComponent(blobName));

    if (req.method === 'GET') {
      const downloadBlockBlobResponse = await blobClient.download();
      const chunks = [];
      for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/xml');
      return res.send(buffer.toString('utf-8'));
    }

    if (req.method === 'POST') {
      let xmlContent = '';
      req.on('data', chunk => {
        xmlContent += chunk.toString();
      });

      await new Promise((resolve, reject) => {
        req.on('end', resolve);
        req.on('error', reject);
      });

      if (!xmlContent || typeof xmlContent !== 'string') {
        throw new Error('Invalid request body');
      }

      const blockBlobClient = blobClient.getBlockBlobClient();
      await blockBlobClient.upload(Buffer.from(xmlContent), xmlContent.length, {
        overwrite: true,
        blobHTTPHeaders: {
          blobContentType: 'application/xml'
        }
      });
      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}; 