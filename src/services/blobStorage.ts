import { BlobServiceClient, BlockBlobClient } from '@azure/storage-blob';

const ACCOUNT_NAME = 'skillsoftlexicons';
const ENDPOINT_SUFFIX = 'core.windows.net';
const CONTAINER_NAME = 'lexicons';

export function getConnectionString(apiKey: string) {
  return `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT_NAME};AccountKey=${apiKey};EndpointSuffix=${ENDPOINT_SUFFIX}`;
}

export async function listBlobs(apiKey: string): Promise<string[]> {
  const connectionString = getConnectionString(apiKey);
  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  const blobNames: string[] = [];
  for await (const blob of containerClient.listBlobsFlat()) {
    blobNames.push(blob.name);
  }
  return blobNames;
}

export async function downloadBlob(apiKey: string, blobName: string): Promise<string> {
  const connectionString = getConnectionString(apiKey);
  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  const blobClient = containerClient.getBlobClient(blobName);
  const downloadBlockBlobResponse = await blobClient.download();
  const downloaded = await streamToStringBrowser(downloadBlockBlobResponse.readableStreamBody);
  return downloaded;
}

export async function uploadBlob(apiKey: string, blobName: string, content: string): Promise<void> {
  const connectionString = getConnectionString(apiKey);
  const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
  const containerClient = blobServiceClient.getContainerClient(CONTAINER_NAME);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);
  
  // Convert string to ArrayBuffer
  const encoder = new TextEncoder();
  const contentBuffer = encoder.encode(content);
  
  // Upload the content
  await blockBlobClient.uploadData(contentBuffer, {
    blobHTTPHeaders: {
      blobContentType: 'text/xml'
    }
  });
}

export async function deleteLexicon(lexiconName: string, apiKey?: string | null): Promise<void> {
  const BACKEND_URL = process.env.NODE_ENV === 'production' 
    ? ''  // In production, use relative path to Vercel API
    : 'http://localhost:4000';
    
  // Only send API key header if provided (suite mode); backend uses env vars otherwise
  const headers: HeadersInit = {
    'Content-Type': 'application/json'
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  
  const response = await fetch(`${BACKEND_URL}/api/lexicon/delete`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ lexiconName }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error || 'Failed to delete lexicon');
  }

  const result = await response.json();
  return result;
}

// Robust browser-compatible stream-to-string
async function streamToStringBrowser(readableStream: any): Promise<string> {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder('utf-8');
  let result = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      result += decoder.decode(new Uint8Array(value), { stream: true });
    }
  }
  return result;
} 