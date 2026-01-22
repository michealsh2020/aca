const { BlobServiceClient } = require('@azure/storage-blob');
const path = require('path');

const ACCOUNT_NAME = 'skillsoftlexicons';
const CONTAINER_NAME = 'lexicons';
const LEXICON_CONTAINER = 'lexicons';
const SETTINGS_CONTAINER = 'settings';

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
  return `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT_NAME};AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

function findLanguageSection(xmlContent, languageId) {
  const languageRegex = new RegExp(
    `(<language[^>]*id=["']${languageId}["'][^>]*>)([\\s\\S]*?)(</language>)`,
    'i'
  );
  
  const match = xmlContent.match(languageRegex);
  return match ? { fullMatch: match[0], startTag: match[1], content: match[2], endTag: match[3] } : null;
}

function addLexiconToLanguage(languageContent, lexiconName, lexiconUrl) {
  const lexiconsRegex = /(<lexicons>)([\s\S]*?)(<\/lexicons>)/i;
  const lexiconsMatch = languageContent.match(lexiconsRegex);
  
  if (lexiconsMatch) {
    const lexiconsContent = lexiconsMatch[2];
    const newLexiconEntry = `\n    <lexicon name="${lexiconName}" id="${lexiconUrl}" />`;
    
    if (lexiconsContent.includes(`id="${lexiconUrl}"`)) {
      throw new Error('Lexicon already exists in settings');
    }
    
    const updatedLexiconsContent = lexiconsContent + newLexiconEntry;
    return languageContent.replace(lexiconsMatch[0], 
      `${lexiconsMatch[1]}${updatedLexiconsContent}\n  ${lexiconsMatch[3]}`);
  } else {
    const newLexiconsSection = `\n  <lexicons>\n    <lexicon name="${lexiconName}" id="${lexiconUrl}" />\n  </lexicons>`;
    return languageContent + newLexiconsSection;
  }
}

function removeLexiconFromLanguage(languageContent, lexiconUrl) {
  const lexiconsRegex = /(<lexicons>)([\s\S]*?)(<\/lexicons>)/i;
  const lexiconsMatch = languageContent.match(lexiconsRegex);
  
  if (!lexiconsMatch) {
    throw new Error('No lexicons section found');
  }
  
  const lexiconsContent = lexiconsMatch[2];
  const lexiconRegex = new RegExp(`\\s*<lexicon[^>]*id=["']${lexiconUrl}["'][^>]*\\/>\\s*`, 'i');
  
  if (!lexiconRegex.test(lexiconsContent)) {
    throw new Error('Lexicon not found in settings');
  }
  
  // Remove the specific lexicon entry
  const updatedLexiconsContent = lexiconsContent.replace(lexiconRegex, '');
  
  // If no lexicons left, remove the entire lexicons section
  if (updatedLexiconsContent.trim() === '') {
    return languageContent.replace(lexiconsMatch[0], '');
  }
  
  return languageContent.replace(lexiconsMatch[0], 
    `${lexiconsMatch[1]}${updatedLexiconsContent}${lexiconsMatch[3]}`);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, x-api-key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    const accountKey = await getAzureStorageKey();
    if (!accountKey) {
      return res.status(401).json({ error: 'API key not configured. Please set azure_storage_key environment variable.' });
    }

    if (path === '/api/blobs' && req.method === 'GET') {
      const connectionString = getConnectionString(accountKey);
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      const blobNames = [];
      for await (const blob of containerClient.listBlobsFlat()) {
        blobNames.push(blob.name);
      }
      return res.json(blobNames);
    }

    if (path.startsWith('/api/blob/') && req.method === 'GET') {
      const blobName = path.replace('/api/blob/', '');
      const connectionString = getConnectionString(accountKey);
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      const blobClient = containerClient.getBlobClient(decodeURIComponent(blobName));
      const downloadBlockBlobResponse = await blobClient.download();
      const chunks = [];
      for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/xml');
      return res.send(buffer.toString('utf-8'));
    }

    if (path.startsWith('/api/blob/') && req.method === 'POST') {
      const blobName = path.replace('/api/blob/', '');
      const connectionString = getConnectionString(accountKey);
      const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
      const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
      const blobClient = containerClient.getBlobClient(decodeURIComponent(blobName));
      
      const xmlContent = await parseBody(req);
      
      if (!xmlContent || typeof xmlContent !== 'string') {
        throw new Error(`Invalid request body: ${xmlContent}`);
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

    if (path === '/api/settings' && req.method === 'GET') {
      try {
        const connectionString = getConnectionString(accountKey);
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(SETTINGS_CONTAINER);
        const blobClient = containerClient.getBlobClient('settings.xml');
        const downloadBlockBlobResponse = await blobClient.download();
        const chunks = [];
        for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const settingsXml = buffer.toString('utf-8');
        
        res.setHeader('Content-Type', 'application/xml');
        return res.send(settingsXml);
      } catch (error) {
        if (error.statusCode === 404) {
          const defaultSettings = `<?xml version="1.0" encoding="UTF-8"?>
<settings>
  <languages>
  </languages>
</settings>`;
          
          const connectionString2 = await getConnectionString(accountKey);
          const blobServiceClient2 = BlobServiceClient.fromConnectionString(connectionString2);
          const containerClient = blobServiceClient2.getContainerClient(SETTINGS_CONTAINER);
          const blobClient = containerClient.getBlobClient('settings.xml');
          const blockBlobClient = blobClient.getBlockBlobClient();
          await blockBlobClient.upload(Buffer.from(defaultSettings), defaultSettings.length, {
            overwrite: true,
            blobHTTPHeaders: {
              blobContentType: 'application/xml'
            }
          });
          
          res.setHeader('Content-Type', 'application/xml');
          return res.send(defaultSettings);
        }
        throw error;
      }
    }

    if (path === '/api/settings/add-lexicon' && req.method === 'POST') {
      const body = await parseBody(req);
      const { languageId, lexiconName, lexiconUrl } = JSON.parse(body);
      
      if (!languageId || !lexiconName || !lexiconUrl) {
        return res.status(400).json({ error: 'Language ID, lexicon name, and URL are required' });
      }

      try {
        const connectionString = getConnectionString(accountKey);
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(SETTINGS_CONTAINER);
        
        const blobClient = containerClient.getBlobClient('settings.xml');
        const downloadBlockBlobResponse = await blobClient.download();
        const chunks = [];
        for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const currentXml = buffer.toString('utf-8');
        
        const languageSection = findLanguageSection(currentXml, languageId);
        if (!languageSection) {
          return res.status(404).json({ error: 'Language not found' });
        }
        
        const updatedLanguageContent = addLexiconToLanguage(
          languageSection.content, 
          lexiconName, 
          lexiconUrl
        );
        
        const updatedXml = currentXml.replace(
          languageSection.fullMatch,
          `${languageSection.startTag}${updatedLanguageContent}${languageSection.endTag}`
        );
        
        const blockBlobClient = blobClient.getBlockBlobClient();
        await blockBlobClient.upload(Buffer.from(updatedXml), updatedXml.length, { 
          overwrite: true,
          blobHTTPHeaders: {
            blobContentType: 'application/xml'
          }
        });
        
        return res.json({ success: true, message: 'Lexicon published successfully' });
        
      } catch (error) {
        console.error('Error adding lexicon to settings:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    if (path === '/api/settings/remove-lexicon' && req.method === 'DELETE') {
      const body = await parseBody(req);
      const { languageId, lexiconUrl } = JSON.parse(body);
      
      if (!languageId || !lexiconUrl) {
        return res.status(400).json({ error: 'Language ID and lexicon URL are required' });
      }

      try {
        const connectionString = getConnectionString(accountKey);
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerClient = blobServiceClient.getContainerClient(SETTINGS_CONTAINER);
        
        const blobClient = containerClient.getBlobClient('settings.xml');
        const downloadBlockBlobResponse = await blobClient.download();
        const chunks = [];
        for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const currentXml = buffer.toString('utf-8');

        const languageSection = findLanguageSection(currentXml, languageId);
        if (!languageSection) {
          return res.status(404).json({ error: 'Language not found' });
        }
        
        const updatedLanguageContent = removeLexiconFromLanguage(
          languageSection.content, 
          lexiconUrl
        );
        
        const updatedXml = currentXml.replace(
          languageSection.fullMatch,
          `${languageSection.startTag}${updatedLanguageContent}${languageSection.endTag}`
        );
        
        const blockBlobClient = blobClient.getBlockBlobClient();
        await blockBlobClient.upload(Buffer.from(updatedXml), updatedXml.length, { 
          overwrite: true,
          blobHTTPHeaders: {
            blobContentType: 'application/xml'
          }
        });
        
        return res.json({ success: true, message: 'Lexicon removed successfully' });
        
      } catch (error) {
        console.error('Error removing lexicon from settings:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    if (path === '/api/lexicon/delete' && req.method === 'DELETE') {
      const body = await parseBody(req);
      const { lexiconName } = JSON.parse(body);
      
      if (!lexiconName) {
        return res.status(400).json({ error: 'Lexicon name is required' });
      }
      
      try {
        const connectionString = getConnectionString(accountKey);
        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        
        const settingsContainerClient = blobServiceClient.getContainerClient(SETTINGS_CONTAINER);
        const settingsBlobClient = settingsContainerClient.getBlobClient('settings.xml');
        
        try {
          const downloadBlockBlobResponse = await settingsBlobClient.download();
          const chunks = [];
          for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
            chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);
          const settingsXml = buffer.toString('utf-8');
          
          if (settingsXml.includes(lexiconName)) {
            return res.status(400).json({ 
              error: 'Cannot delete published lexicon. Please unpublish it first by removing it from settings.' 
            });
          }
        } catch (settingsError) {
          console.log('Settings.xml not accessible, assuming lexicon is unpublished:', settingsError.message);
        }
        
        const lexiconContainerClient = blobServiceClient.getContainerClient(LEXICON_CONTAINER);
        const lexiconBlobClient = lexiconContainerClient.getBlobClient(lexiconName);
        
        try {
          await lexiconBlobClient.getProperties();
        } catch (blobError) {
          if (blobError.statusCode === 404) {
            return res.status(404).json({ error: 'Lexicon not found' });
          }
          throw blobError;
        }
        
        // Download the lexicon content
        const downloadBlockBlobResponse = await lexiconBlobClient.download();
        const chunks = [];
        for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const lexiconContent = buffer.toString('utf-8');
        
        const deletedBlobName = `deleted/${lexiconName}`;
        const deletedBlobClient = lexiconContainerClient.getBlobClient(deletedBlobName);
        const deletedBlockBlobClient = deletedBlobClient.getBlockBlobClient();
        
        await deletedBlockBlobClient.upload(buffer, buffer.length, {
          blobHTTPHeaders: {
            blobContentType: 'text/xml'
          }
        });
        
        await lexiconBlobClient.delete();
        
        console.log(`Successfully moved lexicon ${lexiconName} to deleted folder`);
        return res.json({ success: true, message: 'Lexicon deleted successfully' });
        
      } catch (error) {
        console.error('Error deleting lexicon:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err.message });
  }
}; 