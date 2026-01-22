if (process.env.NODE_ENV !== 'production') {
  try {
    const dotenv = require('dotenv');
    const path = require('path');
    
    let result = dotenv.config({ path: path.join(__dirname, '.env') });
    
    if (result.error) {
      result = dotenv.config({ path: path.join(__dirname, '..', '.env') });
    }
    
    if (result.error) {
      console.warn('Warning: Could not load .env file');
    }
  } catch (e) {
    // dotenv not installed, that's fine for production
  }
}

const express = require('express');
const cors = require('cors');
const { BlobServiceClient } = require('@azure/storage-blob');
const bodyParser = require('body-parser');
const path = require('path');
const { XMLParser, XMLBuilder } = require('fast-xml-parser');
const https = require('https');
const { URL } = require('url');
const { getApiKeys } = require('./api-keys');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const app = express();

async function cleanupOldBackups(containerClient) {
  try {
    const MAX_BACKUPS = 20;
    const backupBlobs = [];
    
    // List all backup files
    for await (const blob of containerClient.listBlobsFlat({ prefix: 'backups/' })) {
      backupBlobs.push({
        name: blob.name,
        lastModified: blob.properties.lastModified
      });
    }
    
    // Sort by last modified date (newest first)
    backupBlobs.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    
    // If we have more than MAX_BACKUPS, delete the oldest ones
    if (backupBlobs.length > MAX_BACKUPS) {
      const backupsToDelete = backupBlobs.slice(MAX_BACKUPS);
      
      console.log(`Cleaning up ${backupsToDelete.length} old backups...`);
      
      for (const backup of backupsToDelete) {
        try {
          const backupBlobClient = containerClient.getBlobClient(backup.name);
          await backupBlobClient.delete();
          console.log(`Deleted old backup: ${backup.name}`);
        } catch (deleteError) {
          console.error(`Failed to delete backup ${backup.name}:`, deleteError);
          // Continue with other deletions even if one fails
        }
      }
      
      console.log(`Backup cleanup complete. Kept ${MAX_BACKUPS} most recent backups.`);
    }
  } catch (error) {
    console.error('Error during backup cleanup:', error);
    // Don't throw error - backup cleanup failure shouldn't break the main operation
  }
}

async function createBackup(blobServiceClient, originalContent) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `backups/settings_backup_${timestamp}.xml`;
    const containerClient = blobServiceClient.getContainerClient('settings');
    const backupBlobClient = containerClient.getBlobClient(backupName);
    const blockBlobClient = backupBlobClient.getBlockBlobClient();
    
    await blockBlobClient.upload(Buffer.from(originalContent), originalContent.length, {
      overwrite: true,
      blobHTTPHeaders: {
        blobContentType: 'application/xml'
      }
    });
    
    console.log(`Backup created: ${backupName}`);
    
    // Clean up old backups after creating new one
    await cleanupOldBackups(containerClient);
    
    return backupName;
  } catch (error) {
    console.error('Failed to create backup:', error);
    throw error;
  }
}

function validateSettingsXml(xmlContent) {
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      preserveOrder: false
    });
    
    const parsed = parser.parse(xmlContent);
    
    if (!parsed.settings) {
      throw new Error('Missing root <settings> element');
    }
    
    if (!parsed.settings.languages) {
      throw new Error('Missing <languages> section');
    }
    
    if (!parsed.settings.languages.language) {
      throw new Error('No <language> elements found');
    }
    
    const languages = Array.isArray(parsed.settings.languages.language) 
      ? parsed.settings.languages.language 
      : [parsed.settings.languages.language];
    
    for (const lang of languages) {
      if (!lang['@_id']) {
        throw new Error('Language missing required "id" attribute');
      }
      
      if (lang.lexicons && lang.lexicons.lexicon) {
        const lexicons = Array.isArray(lang.lexicons.lexicon) 
          ? lang.lexicons.lexicon 
          : [lang.lexicons.lexicon];
        
        for (const lex of lexicons) {
          if (!lex['@_id'] || !lex['@_name']) {
            throw new Error('Lexicon missing required "id" or "name" attribute');
          }
        }
      }
    }
    
    return true;
  } catch (error) {
    throw new Error(`Invalid settings.xml structure: ${error.message}`);
  }
}

async function testTTSIntegration(lexiconUrl) {
  try {
    const url = new URL(lexiconUrl);
    
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'HEAD' }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Lexicon URL not accessible: ${res.statusCode} ${res.statusMessage}`));
        return;
      }
      
      const contentType = res.headers['content-type'];
        if (!contentType || !contentType.includes('xml')) {
          reject(new Error('Lexicon URL does not return XML content'));
          return;
        }
        
        resolve(true);
      });
      
      req.on('error', (error) => {
        reject(new Error(`TTS integration test failed: ${error.message}`));
      });
      
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('TTS integration test timed out'));
      });
      
      req.end();
    });
  } catch (error) {
    console.error('TTS integration test failed:', error);
    throw new Error(`TTS integration test failed: ${error.message}`);
  }
}

async function createStagingSettings(containerClient, updatedXml, operation) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const stagingName = `staging/settings_staging_${operation}_${timestamp}.xml`;
    const stagingBlobClient = containerClient.getBlobClient(stagingName);
    const blockBlobClient = stagingBlobClient.getBlockBlobClient();
    
    await blockBlobClient.upload(Buffer.from(updatedXml), updatedXml.length, {
      overwrite: true,
      blobHTTPHeaders: {
        blobContentType: 'application/xml'
      }
    });
    
    console.log(`Staging file created: ${stagingName}`);
    return stagingName;
  } catch (error) {
    console.error('Failed to create staging file:', error);
    throw error;
  }
}

async function promoteStagingToProduction(containerClient, stagingName) {
  try {
    const stagingBlobClient = containerClient.getBlobClient(stagingName);
    const downloadResponse = await stagingBlobClient.download();
    const chunks = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const stagingContent = buffer.toString('utf-8');
    
    const productionBlobClient = containerClient.getBlobClient('settings.xml');
    const productionBlockBlobClient = productionBlobClient.getBlockBlobClient();
    await productionBlockBlobClient.upload(Buffer.from(stagingContent), stagingContent.length, {
      overwrite: true,
      blobHTTPHeaders: {
        blobContentType: 'application/xml'
      }
    });
    
    await stagingBlobClient.delete();
    console.log(`Staging file promoted to production and cleaned up: ${stagingName}`);
    
    return true;
  } catch (error) {
    console.error('Failed to promote staging to production:', error);
    throw error;
  }
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
  const lexiconFilename = lexiconUrl.split('/').pop();
  
  let lexiconRegex = new RegExp(`\\s*<lexicon[^>]*id=["']${lexiconUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*\\/>\\s*`, 'i');
  
  if (!lexiconRegex.test(lexiconsContent)) {
    lexiconRegex = new RegExp(`\\s*<lexicon[^>]*id=["'][^"']*${lexiconFilename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*\\/>\\s*`, 'i');
  }
  
  if (!lexiconRegex.test(lexiconsContent)) {
    throw new Error('Lexicon not found in settings');
  }
  
  const updatedLexiconsContent = lexiconsContent.replace(lexiconRegex, '');
  
  if (updatedLexiconsContent.trim() === '') {
    return languageContent.replace(lexiconsMatch[0], '');
  }
  
  return languageContent.replace(lexiconsMatch[0], 
    `${lexiconsMatch[1]}${updatedLexiconsContent}${lexiconsMatch[3]}`);
}

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'https://lexicon-editor-i8o6tljfr-colinrice2s-projects.vercel.app',
    'https://lexicon-editor.vercel.app',
    'https://web-lexicon-editor-content-development.dev.eastus.aks.skillsoft.com'
  ],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'x-api-key', 'Authorization'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

app.use(bodyParser.raw({ 
  type: (req) => {
    const contentType = req.headers['content-type'] || '';
    return contentType.includes('xml') || contentType === 'application/xml' || contentType === 'text/xml';
  },
  limit: '50mb' 
}));

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.text({ 
  type: ['text/plain'],
  limit: '50mb' 
}));

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'frontend', 'build')));
  app.use('/static', express.static(path.join(__dirname, '..', 'frontend', 'build', 'static')));
  app.use('/images', express.static(path.join(__dirname, '..', 'frontend', 'build', 'images')));
}

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message });
});

const AZURE_AD_TENANT_ID = '50361608-aa23-494d-a233-2fd14d6a03f4';
const AZURE_AD_CLIENT_ID = '0a0dccee-bf6c-4cfb-8ada-dbfc01518863';
const JWKS_URI = `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}/discovery/v2.0/keys`;

const client = jwksClient({
  jwksUri: JWKS_URI,
  requestHeaders: {},
  timeout: 30000,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    const signingKey = key?.publicKey || key?.rsaPublicKey;
    callback(null, signingKey);
  });
}

async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    
    jwt.verify(token, getKey, {
      audience: AZURE_AD_CLIENT_ID,
      issuer: `https://login.microsoftonline.com/${AZURE_AD_TENANT_ID}/v2.0`,
      algorithms: ['RS256']
    }, (err, decoded) => {
      if (err) {
        return res.status(401).json({ error: 'Invalid token', details: err.message });
      }
      req.user = decoded;
      next();
    });
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ error: 'Token verification failed', details: error.message });
  }
}

const CONTAINER_NAME = 'lexicons';

async function getAzureStorageKey() {
  const apiKeys = await getApiKeys();
  return apiKeys?.azureStorageKey || null;
}

async function getTtsKey() {
  const apiKeys = await getApiKeys();
  return apiKeys?.ttsApiKey || apiKeys?.elevenlabsTtsKey || null;
}

async function getConnectionString(key = null) {
  const accountKey = key || await getAzureStorageKey();
  if (!accountKey) {
    throw new Error('Azure Storage key not configured in environment variables');
  }
  return `DefaultEndpointsProtocol=https;AccountName=skillsoftlexicons;AccountKey=${accountKey};EndpointSuffix=core.windows.net`;
}

app.get('/api/test-route', (req, res) => {
  res.json({ message: 'Test route works' });
});

app.get('/api/keys/status', async (req, res) => {
  try {
      const apiKeys = await getApiKeys();
    
    const status = {
      configured: {
        azureStorageKey: !!(apiKeys?.azureStorageKey),
        azureTtsKey: !!(apiKeys?.ttsApiKey),
        elevenlabsTtsKey: !!(apiKeys?.elevenlabsTtsKey)
      },
      source: apiKeys?.source || 'none',
      allConfigured: !!(apiKeys?.azureStorageKey && apiKeys?.ttsApiKey && apiKeys?.elevenlabsTtsKey)
    };
    
    res.json(status);
  } catch (error) {
    console.error('Error checking API keys status:', error);
    res.status(500).json({ error: 'Failed to check API keys status' });
  }
});

// TTS status endpoint
app.get('/api/tts-status', async (req, res) => {
  const ttsKey = await getTtsKey();
  if (!ttsKey) {
    return res.status(401).json({ error: 'TTS API key not set' });
  }
  
  // For now, just check if the key is set (we'll assume it's valid if it's not empty)
  // In a production environment, you might want to validate it against Azure TTS
  res.json({ status: 'valid', message: 'TTS API key is configured' });
});

// List blobs endpoint
app.get('/api/blobs', async (req, res) => {
  const accountKey = await getAzureStorageKey();
  if (!accountKey) return res.status(401).json({ error: 'API key not set' });
  try {
    const connectionString = await getConnectionString();
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blobNames = [];
    for await (const blob of containerClient.listBlobsFlat()) {
      blobNames.push(blob.name);
    }
    res.json(blobNames);
  } catch (err) {
    console.error('Error listing blobs:', err);
    res.status(500).json({ error: err.message });
  }
});

// Download blob endpoint
app.get('/api/blob/:name', async (req, res) => {
  const accountKey = await getAzureStorageKey();
  if (!accountKey) return res.status(401).json({ error: 'API key not set' });
  try {
    const connectionString = await getConnectionString();
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blobClient = containerClient.getBlobClient(req.params.name);
    
    const downloadBlockBlobResponse = await blobClient.download();
    const chunks = [];
    for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/xml');
    res.send(buffer.toString('utf-8'));
  } catch (err) {
    console.error('Error downloading blob:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload/save endpoint
app.post('/api/blob/:name', async (req, res) => {
  const accountKey = await getAzureStorageKey();
  if (!accountKey) {
    return res.status(401).json({ error: 'API key not set' });
  }
  
  try {
    const connectionString = await getConnectionString();
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blobClient = containerClient.getBlobClient(req.params.name);
    
    const xmlContent = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : req.body;
    
    if (typeof xmlContent !== 'string') {
      throw new Error(`Invalid request body type: ${typeof xmlContent}`);
    }
    
    const blockBlobClient = blobClient.getBlockBlobClient();
    await blockBlobClient.upload(Buffer.from(xmlContent), xmlContent.length, { 
      overwrite: true,
      blobHTTPHeaders: {
        blobContentType: 'application/xml'
      }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving blob:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Test endpoint to save a simple text file
app.post('/api/test-save', async (req, res) => {
  const accountKey = await getAzureStorageKey();
  if (!accountKey) return res.status(401).json({ error: 'API key not set' });
  try {
    const connectionString = await getConnectionString();
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blobClient = containerClient.getBlobClient('test.txt');
    const testContent = 'This is a test file to verify blob storage access.';
    await blobClient.upload(Buffer.from(testContent), Buffer.byteLength(testContent), { 
      overwrite: true,
      blobHTTPHeaders: {
        blobContentType: 'text/plain'
      }
    });
    res.json({ success: true, message: 'Test file saved successfully' });
  } catch (err) {
    console.error('Error saving test file:', err);
    res.status(500).json({ error: err.message });
  }
});

// Settings.xml management endpoints
app.get('/api/settings', async (req, res) => {
  const accountKey = await getAzureStorageKey();
  if (!accountKey) return res.status(401).json({ error: 'API key not set' });
  try {
    const connectionString = await getConnectionString();
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient('settings');
    const blobClient = containerClient.getBlobClient('settings.xml');
    
    const downloadBlockBlobResponse = await blobClient.download();
    const chunks = [];
    for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/xml');
    res.send(buffer.toString('utf-8'));
  } catch (err) {
    console.error('Error downloading settings.xml:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  const accountKey = await getAzureStorageKey();
  if (!accountKey) return res.status(401).json({ error: 'API key not set' });
  try {
    const { xmlContent } = req.body;
    if (!xmlContent) {
      return res.status(400).json({ error: 'XML content is required' });
    }
    
    // Validate XML before saving
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      preserveOrder: true
    });
    
    try {
      parser.parse(xmlContent);
    } catch (parseError) {
      console.error('Invalid XML provided:', parseError);
      return res.status(400).json({ error: 'Invalid XML format provided' });
    }
    
    const connectionString = await getConnectionString();
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient('settings');
    const blobClient = containerClient.getBlobClient('settings.xml');
    
    const blockBlobClient = blobClient.getBlockBlobClient();
    await blockBlobClient.upload(Buffer.from(xmlContent), xmlContent.length, { 
      overwrite: true,
      blobHTTPHeaders: {
        blobContentType: 'application/xml'
      }
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving settings.xml:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/add-lexicon', async (req, res) => {
  const accountKey = await getAzureStorageKey();
  if (!accountKey) return res.status(401).json({ error: 'API key not set' });
  try {
    const { languageId, lexiconName, lexiconUrl } = req.body;
    if (!languageId || !lexiconName || !lexiconUrl) {
      return res.status(400).json({ error: 'Language ID, lexicon name, and URL are required' });
    }
    
    // Download current settings.xml
    const connectionString = await getConnectionString();
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient('settings');
    const blobClient = containerClient.getBlobClient('settings.xml');
    
    const downloadBlockBlobResponse = await blobClient.download();
    const chunks = [];
    for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const currentXml = buffer.toString('utf-8');
    
    await createBackup(blobServiceClient, currentXml);
    
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
    
    const stagingName = await createStagingSettings(containerClient, updatedXml, 'add');
    
    try {
      validateSettingsXml(updatedXml);
      await testTTSIntegration(lexiconUrl);
      await promoteStagingToProduction(containerClient, stagingName);
      res.json({ success: true, message: 'Lexicon published successfully' });
    } catch (validationError) {
      try {
        const stagingBlobClient = containerClient.getBlobClient(stagingName);
        await stagingBlobClient.delete();
      } catch (cleanupError) {
        console.error('Failed to clean up staging file:', cleanupError);
      }
      throw validationError;
    }
  } catch (err) {
    console.error('Error adding lexicon to settings:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/settings/remove-lexicon', async (req, res) => {
  const accountKey = await getAzureStorageKey();
  if (!accountKey) return res.status(401).json({ error: 'API key not set' });
  try {
    const { languageId, lexiconUrl } = req.body;
    if (!languageId || !lexiconUrl) {
      return res.status(400).json({ error: 'Language ID and lexicon URL are required' });
    }
    
    const connectionString = await getConnectionString();
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient('settings');
    const blobClient = containerClient.getBlobClient('settings.xml');
    
    // Download current settings.xml
    const downloadBlockBlobResponse = await blobClient.download();
    const chunks = [];
    for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const currentXml = buffer.toString('utf-8');
    
    await createBackup(blobServiceClient, currentXml);
    
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
    
    const stagingName = await createStagingSettings(containerClient, updatedXml, 'remove');
    
    try {
      validateSettingsXml(updatedXml);
      await promoteStagingToProduction(containerClient, stagingName);
      res.json({ success: true, message: 'Lexicon removed successfully' });
    } catch (validationError) {
      try {
        const stagingBlobClient = containerClient.getBlobClient(stagingName);
        await stagingBlobClient.delete();
      } catch (cleanupError) {
        console.error('Failed to clean up staging file:', cleanupError);
      }
      throw validationError;
    }
    
  } catch (err) {
    console.error('Error removing lexicon from settings:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lexicon/delete', async (req, res) => {
  const accountKey = await getAzureStorageKey();
  if (!accountKey) return res.status(401).json({ error: 'API key not set' });
  try {
    const { lexiconName } = req.body;
    if (!lexiconName) {
      return res.status(400).json({ error: 'Lexicon name is required' });
    }
    
    // First, check if lexicon is published (exists in settings.xml)
    const connectionString = await getConnectionString();
    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const settingsContainerClient = blobServiceClient.getContainerClient('settings');
    const settingsBlobClient = settingsContainerClient.getBlobClient('settings.xml');
    
    try {
      const downloadBlockBlobResponse = await settingsBlobClient.download();
      const chunks = [];
      for await (const chunk of downloadBlockBlobResponse.readableStreamBody) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const settingsXml = buffer.toString('utf-8');
      
      // Check if lexicon is referenced in settings.xml
      if (settingsXml.includes(lexiconName)) {
        return res.status(400).json({ 
          error: 'Cannot delete published lexicon. Please unpublish it first by removing it from settings.' 
        });
      }
    } catch (settingsError) {
      // If settings.xml doesn't exist or can't be read, assume lexicon is unpublished
      console.log('Settings.xml not accessible, assuming lexicon is unpublished:', settingsError.message);
    }
    
    // Check if lexicon exists in blob storage
    const lexiconContainerClient = blobServiceClient.getContainerClient('lexicons');
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
    
    // Move to deleted folder
    const deletedBlobName = `deleted/${lexiconName}`;
    const deletedBlobClient = lexiconContainerClient.getBlobClient(deletedBlobName);
    const deletedBlockBlobClient = deletedBlobClient.getBlockBlobClient();
    
    await deletedBlockBlobClient.upload(buffer, buffer.length, {
      blobHTTPHeaders: {
        blobContentType: 'text/xml'
      }
    });
    
    // Delete the original lexicon
    await lexiconBlobClient.delete();
    
    console.log(`Successfully moved lexicon ${lexiconName} to deleted folder`);
    res.json({ success: true, message: 'Lexicon deleted successfully' });
    
  } catch (err) {
    console.error('Error deleting lexicon:', err);
    res.status(500).json({ error: err.message });
  }
});

if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'build', 'index.html'));
  });
}

const PORT = process.env.PORT || 4000;

app.listen(PORT, async () => {
  console.log(`Backend proxy running on http://localhost:${PORT}`);
  const apiKeys = await getApiKeys();
  if (apiKeys?.azureStorageKey) {
    console.log('✓ Azure Storage key available');
  } else {
    console.warn('⚠ Azure Storage key not found');
  }
  if (apiKeys?.ttsApiKey || apiKeys?.elevenlabsTtsKey) {
    console.log('✓ TTS API key available');
  } else {
    console.warn('⚠ TTS API key not found');
  }
}); 