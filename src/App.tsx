/**
 * Lexicon Editor Application
 * 
 * IMPORTANT: Before making any changes to this codebase, please review the AI_CONSTRAINTS.md file
 * in the root directory. It contains important guidelines and rules that must be followed
 * when modifying this application.
 */

import React, { useState, useEffect, useRef } from 'react';
import './index.css';
import { XMLParser } from 'fast-xml-parser';
import { deleteLexicon } from './services/blobStorage';
import { ProtectedRoute } from './ProtectedRoute';
import { useAuth } from './authContext';

function deepEqual(a: any, b: any) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Shared styles - moved outside component to avoid recreation on every render
const unifiedInputStyle = { height: '36px', minHeight: '36px', maxHeight: '36px', borderRadius: '0.5rem', padding: '0 1rem', fontSize: '0.875rem', lineHeight: '1.5' };
const unifiedButtonStyle = { minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' };
const entryBoxStyle: React.CSSProperties = { ...unifiedInputStyle, background: 'white', border: '1px solid #e5e7eb', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', boxSizing: 'border-box' as React.CSSProperties['boxSizing'], fontWeight: 400 };

// Constants
const TOAST_DURATION = 3000; // 3 seconds
const RETRY_BASE_DELAY = 1000; // 1 second base delay for retries

interface LexiconEntry {
  graphemes: string[];
  alias?: string;
  aliasSayAsType?: string;
  phoneme?: string;
  phonemeSayAsType?: string;
  isNew?: boolean;
}

interface MergeConflict {
  type: 'additional_alias' | 'conflict';
  masterEntry: LexiconEntry;
  mergeEntry: LexiconEntry;
  masterIndex: number;
  mergeIndex: number;
  commonGraphemes: string[];
  resolution: 'master' | 'merge' | 'both' | null;
}

// Pre-compiled regex for performance - only create once instead of on every keystroke
// Includes > and < which are commonly used in lexicons for pronunciation guides and notation
const VALID_IPA_CHARS_REGEX = /[a-zA-Zɑɐɒæɓʙβɔɕçɗɖðʤʣɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸœɶʘɹɺɾɻʀʁɽʂʃʈʧθʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑ̆̊̃̂̀́̋̏̌̂̃̄̅̈̇̍̎̍̋̋̊̌̀́̂̃̄̅̆̇̈̉̊̋̌̍̎̄̃̂̀́̋̏̎̍̇̈̅̄̌̊̆̌̍̎̏̋̊̈̇̆̅̄̃̂́̀ .ˌˈǁǀǂǃʰʲʷʸˠˤⁿˡᵈᵗᵇᵏᵍᶠᶿᵋᶦᶧᶨᶩᶪᶫᶬᶭᶮᶯᶰᶱᶲᶳᶴᶵᶶᶷᶸᶹᶺᶻᶼᶽᶾᶿ><]/g;

// Say-as options for SSML compatibility
const SAY_AS_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'characters', label: 'Characters (spell out)' },
  { value: 'spell-out', label: 'Spell Out' },
  { value: 'cardinal', label: 'Cardinal (numbers)' },
  { value: 'ordinal', label: 'Ordinal (1st, 2nd, etc.)' },
  { value: 'digits', label: 'Digits (one by one)' },
  { value: 'fraction', label: 'Fraction' },
  { value: 'unit', label: 'Unit (measurement)' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'telephone', label: 'Telephone number' },
  { value: 'address', label: 'Address' },
  { value: 'name', label: 'Name' },
  { value: 'net', label: 'Network/URL' },
  { value: 'currency', label: 'Currency' },
  { value: 'measure', label: 'Measure' },
  { value: 'verbatim', label: 'Verbatim (exact pronunciation)' }
];

function App() {
  const { isAuthenticated, getAccessToken } = useAuth();
  const [entries, setEntries] = useState<LexiconEntry[]>([]);
  const [savedEntries, setSavedEntries] = useState<LexiconEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [currentFile, setCurrentFile] = useState<string>('');
  const [showFileModal, setShowFileModal] = useState(false);
  const [showNewLexiconModal, setShowNewLexiconModal] = useState(false);
  const [newLexiconName, setNewLexiconName] = useState('');
  const [newLexiconError, setNewLexiconError] = useState<string | null>(null);
  const [newLexiconLang, setNewLexiconLang] = useState('en-US');
  const [blobList, setBlobList] = useState<string[]>([]);
  const [loadingBlobs, setLoadingBlobs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blobErrorDetail, setBlobErrorDetail] = useState<string | null>(null);
  const [activeTooltip, setActiveTooltip] = useState<string | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const [retryCount, setRetryCount] = useState(0);
  const MAX_RETRIES = 3;
  const [searchQuery, setSearchQuery] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mergeFileInputRef = useRef<HTMLInputElement>(null);
  const entriesListRef = useRef<HTMLDivElement>(null);
  const phonemeWarningTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [showImportSavePrompt, setShowImportSavePrompt] = useState(false);
  const [showExportFormatModal, setShowExportFormatModal] = useState(false);
  const [pendingLexiconSwitch, setPendingLexiconSwitch] = useState<null | (() => void)>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [validationErrors, setValidationErrors] = useState<{[index: number]: string[]}>({});
  const [phonemeInputWarning, setPhonemeInputWarning] = useState<string | null>(null);
  const [showSaveAsModal, setShowSaveAsModal] = useState(false);
  const [saveAsError, setSaveAsError] = useState('');
  const [showOverwriteModal, setShowOverwriteModal] = useState(false);
  const [deletingLexicon, setDeletingLexicon] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [lexiconToDelete, setLexiconToDelete] = useState<string | null>(null);
  const [overwriteFilename, setOverwriteFilename] = useState('');
  const [saveAsFilename, setSaveAsFilename] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error'>('success');
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState('en-US');
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [mergeFile, setMergeFile] = useState<File | null>(null);
  const [mergeFileContent, setMergeFileContent] = useState<LexiconEntry[]>([]);
  const [mergeConflicts, setMergeConflicts] = useState<MergeConflict[]>([]);
  const [showConflictResolution, setShowConflictResolution] = useState(false);
  const [mergeLanguage, setMergeLanguage] = useState('');
  const [mergeFileName, setMergeFileName] = useState('');
  const [mergeErrors, setMergeErrors] = useState<string[]>([]);
  const [mergeDetailedErrors, setMergeDetailedErrors] = useState<Array<{
    lineNumber?: number;
    entryContent?: string;
    errorType: 'xml_parse' | 'invalid_entry' | 'missing_element' | 'invalid_character' | 'language_mismatch' | 'general';
    message: string;
    suggestion?: string;
  }>>([]);
  const [mergePreview, setMergePreview] = useState<{
    newEntries: number;
    conflicts: number;
    autoMerged: number;
    identicalSkipped: number;
    errors: number;
    potentialIssues: Array<{
      type: 'conflict' | 'duplicate' | 'error';
      message: string;
      entry?: LexiconEntry;
    }>;
  } | null>(null);
  const [mergeSummary, setMergeSummary] = useState<{
    newEntries: number;
    conflictsResolved: number;
    identicalSkipped: number;
    totalProcessed: number;
    errorsFound: number;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [showPreviewIframe, setShowPreviewIframe] = useState(false);
  const [showEmbeddedPreview, setShowEmbeddedPreview] = useState(false);
  const [showFloatingPreview, setShowFloatingPreview] = useState(false);
  const [previewButtonRef, setPreviewButtonRef] = useState<HTMLButtonElement | null>(null);
  const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const [publishLoading, setPublishLoading] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const [removeLoading, setRemoveLoading] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [settingsLexicons, setSettingsLexicons] = useState<{[languageId: string]: Array<{name: string, url: string}>}>({});
  const [loadingSettings, setLoadingSettings] = useState(false);
  
  // Suite mode state
  const [isSuiteMode, setIsSuiteMode] = useState(false);
  const [suiteLexiconKey, setSuiteLexiconKey] = useState<string | null>(null);
  const [suiteTtsKey, setSuiteTtsKey] = useState<string | null>(null);

  // Backend API endpoints
  const BACKEND_URL = process.env.NODE_ENV === 'production' 
    ? ''  // In production, use relative path to Vercel API
    : 'http://localhost:4000';

  // Helper function to get Lexicon API key (suite mode only - normal mode uses env vars)
  const getLexiconApiKey = () => {
    // Only return API key in suite mode (from parent window)
    // In normal mode, backend uses environment variables automatically
    if (isSuiteMode && suiteLexiconKey) {
      return suiteLexiconKey;
    }
    return null; // No manual API keys allowed
  };

  // Helper function to get TTS API key (suite mode only - normal mode uses env vars)
  const getTtsApiKey = () => {
    // Only return API key in suite mode (from parent window)
    // In normal mode, backend uses environment variables automatically
    if (isSuiteMode && suiteTtsKey) {
      return suiteTtsKey;
    }
    return null; // No manual API keys allowed
  };

  async function listBlobsFromBackend() {
    // Only send API key header in suite mode; backend uses env vars otherwise
    const headers: HeadersInit = {};
    if (isSuiteMode) {
      const apiKey = getLexiconApiKey();
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      }
    }
    
    const response = await fetch(`${BACKEND_URL}/api/blobs`, { headers });
    if (response.status === 401) throw new Error('API key not set');
    if (!response.ok) throw new Error('Failed to list blobs');
    const blobs = await response.json();
    
    // Filter out deleted directory and any files in the deleted folder
    return blobs.filter((blob: string) => !blob.startsWith('deleted/'));
  }

  async function downloadBlobFromBackend(blobName: string) {
    // Only send API key header in suite mode; backend uses env vars otherwise
    const headers: HeadersInit = {};
    if (isSuiteMode) {
      const apiKey = getLexiconApiKey();
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      }
    }
    
    const response = await fetch(`${BACKEND_URL}/api/blob/${encodeURIComponent(blobName)}`, { headers });
    if (response.status === 401) throw new Error('API key not set');
    if (!response.ok) throw new Error('Failed to download blob');
    return await response.text();
  }


  // Send TTS API key to iframe via postMessage
  function sendTtsKeyToIframe(iframe: HTMLIFrameElement) {
    const ttsKey = getTtsApiKey();
    if (ttsKey && iframe.contentWindow) {
      iframe.contentWindow.postMessage({
        type: 'SET_TTS_KEY',
        key: ttsKey,
        provider: 'azure'
      }, 'https://web-tts-content-development.dev.eastus.aks.skillsoft.com');
    }
  }


  // Settings.xml management functions
  async function loadSettingsLexicons() {
    // Only send API key header in suite mode; backend uses env vars otherwise
    const headers: HeadersInit = {};
    if (isSuiteMode) {
      const apiKey = getLexiconApiKey();
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      }
    }
    
    const response = await fetch(`${BACKEND_URL}/api/settings`, { headers });
    if (response.status === 401) throw new Error('API key not set');
    if (!response.ok) throw new Error('Failed to load settings');
    return await response.text();
  }

  async function addLexiconToSettings(languageId: string, lexiconName: string, lexiconUrl: string) {
    // Only send API key header in suite mode; backend uses env vars otherwise
    const headers: HeadersInit = {
      'Content-Type': 'application/json'
    };
    if (isSuiteMode) {
      const apiKey = getLexiconApiKey();
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      }
    }
    
    const response = await fetch(`${BACKEND_URL}/api/settings/add-lexicon`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ languageId, lexiconName, lexiconUrl })
    });
    if (response.status === 401) throw new Error('API key not set');
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to add lexicon to settings');
    }
    return await response.json();
  }

  async function removeLexiconFromSettings(languageId: string, lexiconUrl: string) {
    // Only send API key header in suite mode; backend uses env vars otherwise
    const headers: HeadersInit = {
      'Content-Type': 'application/json'
    };
    if (isSuiteMode) {
      const apiKey = getLexiconApiKey();
      if (apiKey) {
        headers['x-api-key'] = apiKey;
      }
    }
    
    const response = await fetch(`${BACKEND_URL}/api/settings/remove-lexicon`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ languageId, lexiconUrl })
    });
    if (response.status === 401) throw new Error('API key not set');
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to remove lexicon from settings');
    }
    return await response.json();
  }

  async function saveLexicon(blobName: string, xmlString: string) {
    try {
      // Ensure we have a valid string
      if (!xmlString || typeof xmlString !== 'string') {
        throw new Error('Invalid XML string');
      }

      // Get authentication token (optional - backend will handle auth)
      let token = null;
      try {
        token = await getAccessToken();
      } catch (authError) {
        console.warn('Could not get auth token, proceeding without it:', authError);
      }

      // Only send API key header in suite mode; backend uses env vars otherwise
      const headers: HeadersInit = { 
        'Content-Type': 'application/xml',
        'Accept': 'application/json'
      };
      
      // Add auth token if available
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      if (isSuiteMode) {
        const apiKey = getLexiconApiKey();
        if (apiKey) {
          headers['x-api-key'] = apiKey;
        }
      }
      
      console.log('Saving lexicon:', blobName, 'Suite mode:', isSuiteMode, 'Has API key header:', !!headers['x-api-key'], 'Has auth token:', !!token);
      
      // Send the XML string to the backend
      const response = await fetch(`${BACKEND_URL}/api/blob/${encodeURIComponent(blobName)}`, {
        method: 'POST',
        headers,
        body: xmlString
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Save failed - Server response:', {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: errorText
        });
        throw new Error(`Failed to save lexicon: ${response.status} ${response.statusText} - ${errorText}`);
      }
      
      const result = await response.json();
      console.log('Lexicon saved successfully:', blobName);
      return result;
    } catch (e) {
      console.error('Save error details:', e);
      throw e;
    }
  }

  // Function to refresh lexicon list
  const refreshLexiconList = async () => {
    try {
      setLoadingBlobs(true);
      const blobs = await listBlobsFromBackend();
      setBlobList(blobs);
      setError(null);
      setBlobErrorDetail(null);
    } catch (e: any) {
      console.error('Error refreshing lexicon list:', e);
      setError('Failed to refresh lexicon list. Please try again.');
      setBlobErrorDetail(e.message);
    } finally {
      setLoadingBlobs(false);
    }
  };

  // useEffect for document title (always at top level)
  useEffect(() => {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      document.title = '(local) Skillsoft Lexicon Editor';
    } else {
      document.title = 'Skillsoft Lexicon Editor';
    }
  }, []);

  // Suite mode detection and postMessage listener
  useEffect(() => {
    // Check for suite mode via URL parameter
    const urlParams = new URLSearchParams(window.location.search);
    const mode = urlParams.get('mode');
    if (mode === 'suite') {
      setIsSuiteMode(true);
    }

    // Listen for postMessage events from trusted origins
    const handleMessage = async (event: MessageEvent) => {
      // Check if origin is trusted
      const trustedOrigins = [
        'http://localhost:3000',
        'http://localhost:3001',
        'https://lexicon-editor.vercel.app',
        'https://lexicon-editor-git-dev.vercel.app',
        'https://web-lexicon-editor-content-development.dev.eastus.aks.skillsoft.com'
      ];
      
      if (!trustedOrigins.includes(event.origin)) {
        console.warn('Received postMessage from untrusted origin:', event.origin);
        return;
      }

      // Handle API key messages
      if (event.data && event.data.type === 'SET_TTS_KEY') {
        const { key, provider } = event.data;
        
        if (!key || !provider) {
          console.error('Invalid SET_TTS_KEY message: missing key or provider');
          return;
        }

        try {
          // Store the key in state (suite mode trusts the parent app)
          if (provider === 'azure') {
            setSuiteLexiconKey(key);
            console.log('Suite mode: Lexicon API key received');
          } else {
            setSuiteTtsKey(key);
            console.log('Suite mode: TTS API key received');
          }
        } catch (error) {
          console.error('Suite mode: Error processing API key:', error);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  // Load blob list when authenticated
  useEffect(() => {
    // Don't make API calls until authenticated
    if (!isAuthenticated) {
      return;
    }
    
    let mounted = true;
    let timeoutId: NodeJS.Timeout;

    const loadBlobs = async () => {
      try {
        setLoadingBlobs(true);
        const blobs = await listBlobsFromBackend();
        if (mounted) {
          setBlobList(blobs);
          setError(null);
          setBlobErrorDetail(null);
          setIsInitialLoad(false);
        }
      } catch (e: any) {
        if (mounted) {
          console.error('Error loading blobs:', e);
          if (retryCount < MAX_RETRIES) {
            // Retry after a delay
            timeoutId = setTimeout(() => {
              setRetryCount(prev => prev + 1);
            }, RETRY_BASE_DELAY * (retryCount + 1)); // Exponential backoff
          } else {
            setError('Failed to load blobs. Please try again.');
            setBlobErrorDetail(e.message);
          }
        }
      } finally {
        if (mounted) {
          setLoadingBlobs(false);
        }
      }
    };

    loadBlobs();

    return () => {
      mounted = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [retryCount, isAuthenticated]);

  // Save prompt logic for lexicon switching
  const promptToSaveIfNeeded = (onContinue: () => void) => {
    if (hasUnsavedChanges) {
      setPendingLexiconSwitch(() => onContinue);
      setShowImportModal(true);
    } else {
      onContinue();
    }
  };

  // Modified handleOpenLexicon to prompt
  const handleOpenLexicon = async () => {
    promptToSaveIfNeeded(() => {
      setShowFileModal(true);
      setError(null);
      setBlobErrorDetail(null);
      setRetryCount(0); // Reset retry count when manually opening
    });
  };

  // Modified handleSelectBlob to prompt
  const handleSelectBlob = async (blobName: string) => {
    promptToSaveIfNeeded(async () => {
      setLoadingBlobs(true);
      setError(null);
      try {
        const xmlString = await downloadBlobFromBackend(blobName);
        const parser = new XMLParser({ 
          ignoreAttributes: false,
          attributeNamePrefix: "@_",
          textNodeName: "#text"
        });
        let xml;
        try {
          xml = parser.parse(xmlString);
          if (!xml || !xml.lexicon) {
            throw new Error('Invalid lexicon format');
          }
          const ns = xml.lexicon['@_xmlns'] || xml.lexicon['@_xmlns:xsi'] || '';
          // Convert any entry tags to lexeme tags
          const entries = Array.isArray(xml.lexicon.entry)
            ? xml.lexicon.entry
            : xml.lexicon.entry ? [xml.lexicon.entry] : [];
          const lexemes = Array.isArray(xml.lexicon.lexeme)
            ? xml.lexicon.lexeme
            : xml.lexicon.lexeme ? [xml.lexicon.lexeme] : [];
          // Combine and convert all entries to lexeme format
          const parsedEntries = [...entries, ...lexemes].map((lex: any) => ({
            graphemes: Array.isArray(lex.grapheme)
              ? lex.grapheme.map((g: any) => g['#text'] || g) : lex.grapheme ? [lex.grapheme['#text'] || lex.grapheme] : [],
            alias: lex.alias?.['#text'] || lex.alias || '',
            aliasSayAsType: lex.alias?.['@_interpret-as'] || '',
            phoneme: lex.phoneme?.['#text'] || lex.phoneme || '',
            phonemeSayAsType: lex.phoneme?.['@_interpret-as'] || ''
          }));
          setEntries(parsedEntries);
          setSavedEntries(parsedEntries);
          setValidationErrors({}); // Clear validation errors when loading new lexicon
          setPhonemeInputWarning(null); // Clear phoneme warning when loading new lexicon
          setCurrentFile(blobName);
          const lang = xml.lexicon['@_xml:lang'] || xml.lexicon['@_lang'] || 'en-US';
          setNewLexiconLang(lang);
          setSelectedLanguage(lang);
          setShowFileModal(false);
          clearPanelOnLexiconLoad();
          // Load current settings data to check if this lexicon is published
          await loadSettingsData();
        } catch (e) {
          console.error('Error parsing lexicon:', e);
          setError('Failed to download or parse the file.');
        }
        setLoadingBlobs(false);
      } catch (e) {
        console.error('Error parsing lexicon:', e);
        setError('Failed to download or parse the file.');
      }
    });
  };

    // Modified handleDuplicateLexicon to prompt
  const handleDuplicateLexicon = () => {
    promptToSaveIfNeeded(async () => {
      if (!currentFile) return;
      const baseName = currentFile.replace(/\.xml$/i, '');
      const newName = `duplicate-of-${baseName}.xml`;
      const duplicatedEntries = entries.map(entry => ({
        graphemes: [...entry.graphemes],
        alias: entry.alias,
        phoneme: entry.phoneme
      }));
      setEntries(duplicatedEntries);
      setSavedEntries([]); // Mark as unsaved
      setValidationErrors({}); // Clear validation errors when duplicating
      setPhonemeInputWarning(null); // Clear phoneme warning when duplicating
      setCurrentFile(newName);
      setBlobList((prev) => prev.includes(newName) ? prev : [newName, ...prev]);
      setNewLexiconName(newName);
      clearPanelOnLexiconLoad();
      // Load current settings data to check if this lexicon is published
      await loadSettingsData();
    });
  };

  // Import handler
  const handleImportClick = () => {
    if (hasUnsavedChanges) {
      setShowImportModal(true);
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    console.log('File selected:', file?.name, 'hasUnsavedChanges:', hasUnsavedChanges);
    if (file) {
      if (hasUnsavedChanges) {
        console.log('Has unsaved changes, showing import modal');
        setPendingImportFile(file);
        setShowImportModal(true);
      } else {
        console.log('No unsaved changes, importing directly');
        importLexiconFile(file);
      }
    } else {
      console.log('No file selected');
    }
    // Reset input so same file can be picked again
    e.target.value = '';
  };

  const buildXMLFromEntries = (entries: LexiconEntry[]): string => {
    const NS = 'http://www.w3.org/2005/01/pronunciation-lexicon';
    const doc = document.implementation.createDocument('', '', null);
    const root = doc.createElementNS(NS, 'lexicon');
    root.setAttribute('version', '1.0');
    root.setAttribute('xml:lang', 'en-US'); // Default language for TSV imports
    root.setAttribute('xmlns', NS);
    root.setAttribute('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance');
    root.setAttribute('xsi:schemaLocation', 'http://www.w3.org/2005/01/pronunciation-lexicon http://www.w3.org/TR/2007/CR-pronunciation-lexicon-20071212/pls.xsd');
    root.setAttribute('alphabet', 'ipa');

    entries.forEach(entry => {
      const lexemeElement = doc.createElementNS(NS, 'lexeme');
      entry.graphemes.forEach(grapheme => {
        const graphemeElement = doc.createElementNS(NS, 'grapheme');
        graphemeElement.textContent = grapheme;
        lexemeElement.appendChild(graphemeElement);
      });
      if (entry.alias) {
        const aliasElement = doc.createElementNS(NS, 'alias');
        aliasElement.textContent = entry.alias;
        if (entry.aliasSayAsType && entry.aliasSayAsType.trim() && entry.aliasSayAsType !== '') {
          const validSayAsTypes = SAY_AS_OPTIONS.map(opt => opt.value).filter(val => val !== '');
          if (validSayAsTypes.includes(entry.aliasSayAsType)) {
            aliasElement.setAttribute('interpret-as', entry.aliasSayAsType);
          }
        }
        lexemeElement.appendChild(aliasElement);
      }
      if (entry.phoneme) {
        const phonemeElement = doc.createElementNS(NS, 'phoneme');
        phonemeElement.textContent = entry.phoneme;
        if (entry.phonemeSayAsType && entry.phonemeSayAsType.trim() && entry.phonemeSayAsType !== '') {
          const validSayAsTypes = SAY_AS_OPTIONS.map(opt => opt.value).filter(val => val !== '');
          if (validSayAsTypes.includes(entry.phonemeSayAsType)) {
            phonemeElement.setAttribute('interpret-as', entry.phonemeSayAsType);
          }
        }
        lexemeElement.appendChild(phonemeElement);
      }
      root.appendChild(lexemeElement);
    });

    doc.appendChild(root);
    const serializer = new XMLSerializer();
    const xmlString = serializer.serializeToString(doc);
    const xmlWithDeclaration = xmlString.startsWith('<?xml') ? xmlString : '<?xml version="1.0" encoding="utf-8"?>\n' + xmlString;
    return xmlWithDeclaration;
  };

  const importLexiconFile = async (file: File) => {
    console.log('importLexiconFile called with file:', file.name);
    console.log('File size:', file.size, 'bytes');
    console.log('File type:', file.type);
    console.log('Environment:', process.env.NODE_ENV);
    console.log('Backend URL:', BACKEND_URL);
    
    try {
      const text = await file.text();
      console.log('File text loaded, length:', text.length);
      
      // Check if it's a CSV or TSV file
      const isCSV = file.name.toLowerCase().endsWith('.csv') || 
                   (text.includes(',') && text.split('\n')[0].includes('grapheme') && !text.includes('\t'));
      const isTSV = file.name.toLowerCase().endsWith('.tsv') || 
                   file.name.toLowerCase().endsWith('.txt') ||
                   (text.includes('\t') && text.split('\n')[0].includes('grapheme'));
      
      if (isCSV) {
        console.log('Detected CSV format, parsing and converting to XML...');
        try {
          const parsedEntries = parseCSV(text);
          console.log('CSV parsed successfully, entries:', parsedEntries.length);
          
          // Convert CSV entries to XML format internally
          const xmlContent = buildXMLFromEntries(parsedEntries);
          console.log('Converted CSV to XML format');
          
          // Parse the XML to ensure it's valid and get the proper structure
          const parser = new XMLParser({ 
            ignoreAttributes: false,
            attributeNamePrefix: "@_",
            textNodeName: "#text"
          });
          const xml = parser.parse(xmlContent);
          
          // Use the same XML processing logic as regular XML imports
          let lexicon;
          if (xml.lexicon) {
            lexicon = xml.lexicon;
          } else {
            lexicon = xml;
          }
          
          if (!lexicon) {
            throw new Error('Invalid lexicon format after CSV conversion');
          }
          
          // Process the converted XML using existing logic
          let entries = [];
          let lexemes = [];
          
          try {
            entries = Array.isArray(lexicon.entry) ? lexicon.entry : lexicon.entry ? [lexicon.entry] : [];
            lexemes = Array.isArray(lexicon.lexeme) ? lexicon.lexeme : lexicon.lexeme ? [lexicon.lexeme] : [];
            
            if (!Array.isArray(entries)) {
              console.warn('Entries is not an array, converting:', entries);
              entries = [];
            }
            if (!Array.isArray(lexemes)) {
              console.warn('Lexemes is not an array, converting:', lexemes);
              lexemes = [];
            }
          } catch (parseError) {
            console.error('Error processing converted XML:', parseError);
            throw new Error('Error processing converted lexicon data');
          }
          
          // Convert to LexiconEntry format using existing logic
          const allEntries = [...entries, ...lexemes];
          const lexiconEntries: LexiconEntry[] = allEntries.map((entry: any) => {
            const graphemes: string[] = [];
            const graphemeElements = Array.isArray(entry.grapheme) ? entry.grapheme : entry.grapheme ? [entry.grapheme] : [];
            graphemeElements.forEach((g: any) => {
              if (g && typeof g === 'object' && g['#text']) {
                graphemes.push(g['#text']);
              } else if (typeof g === 'string') {
                graphemes.push(g);
              }
            });
            
            const aliasElement = entry.alias;
            const phonemeElement = entry.phoneme;
            
            return {
              graphemes,
              alias: aliasElement && typeof aliasElement === 'object' ? aliasElement['#text'] : aliasElement || '',
              aliasSayAsType: aliasElement && typeof aliasElement === 'object' ? aliasElement['@_interpret-as'] : '',
              phoneme: phonemeElement && typeof phonemeElement === 'object' ? phonemeElement['#text'] : phonemeElement || '',
              phonemeSayAsType: phonemeElement && typeof phonemeElement === 'object' ? phonemeElement['@_interpret-as'] : ''
            };
          });
          
          setEntries(lexiconEntries);
          setSavedEntries([...lexiconEntries]);
          setPhonemeInputWarning(null);
          setCurrentFile(file.name.replace(/\.(csv|tsv|txt)$/i, '.xml')); // Convert filename to .xml
          setNewLexiconLang(lexicon['@_xml:lang'] || lexicon['@_lang'] || 'en-US');
          setShowImportSavePrompt(true);
          setShowImportModal(false);
          setPendingImportFile(null);
          clearPanelOnLexiconLoad();
          await loadSettingsData();
          return;
        } catch (err) {
          console.error('Error parsing CSV:', err);
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          setError(`The imported CSV file is malformed or invalid: ${errorMessage}`);
          setShowImportModal(false);
          setPendingImportFile(null);
          return;
        }
      }
      
      if (isTSV) {
        console.log('Detected TSV format, parsing and converting to XML...');
        try {
          const parsedEntries = parseTSV(text);
          console.log('TSV parsed successfully, entries:', parsedEntries.length);
          
          // Convert TSV entries to XML format internally
          const xmlContent = buildXMLFromEntries(parsedEntries);
          console.log('Converted TSV to XML format');
          
          // Parse the XML to ensure it's valid and get the proper structure
          const parser = new XMLParser({ 
            ignoreAttributes: false,
            attributeNamePrefix: "@_",
            textNodeName: "#text"
          });
          const xml = parser.parse(xmlContent);
          
          // Use the same XML processing logic as regular XML imports
          let lexicon;
          if (xml.lexicon) {
            lexicon = xml.lexicon;
          } else {
            lexicon = xml;
          }
          
          if (!lexicon) {
            throw new Error('Invalid lexicon format after TSV conversion');
          }
          
          // Process the converted XML using existing logic
          let entries = [];
          let lexemes = [];
          
          try {
            entries = Array.isArray(lexicon.entry) ? lexicon.entry : lexicon.entry ? [lexicon.entry] : [];
            lexemes = Array.isArray(lexicon.lexeme) ? lexicon.lexeme : lexicon.lexeme ? [lexicon.lexeme] : [];
            
            if (!Array.isArray(entries)) {
              console.warn('Entries is not an array, converting:', entries);
              entries = [];
            }
            if (!Array.isArray(lexemes)) {
              console.warn('Lexemes is not an array, converting:', lexemes);
              lexemes = [];
            }
          } catch (parseError) {
            console.error('Error processing converted XML:', parseError);
            throw new Error('Error processing converted lexicon data');
          }
          
          // Convert to LexiconEntry format using existing logic
          const allEntries = [...entries, ...lexemes];
          const lexiconEntries: LexiconEntry[] = allEntries.map((entry: any) => {
            const graphemes: string[] = [];
            const graphemeElements = Array.isArray(entry.grapheme) ? entry.grapheme : entry.grapheme ? [entry.grapheme] : [];
            graphemeElements.forEach((g: any) => {
              if (g && typeof g === 'object' && g['#text']) {
                graphemes.push(g['#text']);
              } else if (typeof g === 'string') {
                graphemes.push(g);
              }
            });
            
            const aliasElement = entry.alias;
            const phonemeElement = entry.phoneme;
            
            return {
              graphemes,
              alias: aliasElement && typeof aliasElement === 'object' ? aliasElement['#text'] : aliasElement || '',
              aliasSayAsType: aliasElement && typeof aliasElement === 'object' ? aliasElement['@_interpret-as'] : '',
              phoneme: phonemeElement && typeof phonemeElement === 'object' ? phonemeElement['#text'] : phonemeElement || '',
              phonemeSayAsType: phonemeElement && typeof phonemeElement === 'object' ? phonemeElement['@_interpret-as'] : ''
            };
          });
          
          setEntries(lexiconEntries);
          setSavedEntries([...lexiconEntries]);
          setPhonemeInputWarning(null);
          setCurrentFile(file.name.replace(/\.(tsv|txt)$/i, '.xml')); // Convert filename to .xml
          setNewLexiconLang(lexicon['@_xml:lang'] || lexicon['@_lang'] || 'en-US');
          setShowImportSavePrompt(true);
          setShowImportModal(false);
          setPendingImportFile(null);
          clearPanelOnLexiconLoad();
          await loadSettingsData();
          return;
        } catch (err) {
          console.error('Error parsing TSV:', err);
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          setError(`The imported TSV file is malformed or invalid: ${errorMessage}`);
          setShowImportModal(false);
          setPendingImportFile(null);
          return;
        }
      }
      
      // XML parsing (existing logic)
      const parser = new XMLParser({ 
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        textNodeName: "#text"
      });
      let xml;
      try {
        xml = parser.parse(text);
        console.log('XML parsed successfully:', xml);
      } catch (err) {
        console.error('Error parsing XML:', err);
        setError('The imported XML file is malformed or invalid.');
        setShowImportModal(false);
        setPendingImportFile(null);
        return;
      }
      // Handle different XML structures - xml might be an object or array
      let lexicon;
      
      console.log('XML structure:', typeof xml, Array.isArray(xml), xml);
      
      // More robust parsing - handle any possible structure
      if (Array.isArray(xml)) {
        console.log('XML is array, length:', xml.length);
        // Look for lexicon in array elements
        for (const node of xml) {
          if (node && typeof node === 'object' && node.lexicon) {
            lexicon = node.lexicon;
            break;
          }
        }
      } else if (xml && typeof xml === 'object') {
        // Direct lexicon property
        if (xml.lexicon) {
          console.log('XML is object with lexicon property');
          lexicon = xml.lexicon;
        } else {
          // Maybe the root IS the lexicon
          console.log('XML root might be lexicon itself');
          lexicon = xml;
        }
      }
      
      if (!lexicon) {
        console.error('Unexpected XML structure:', xml);
        throw new Error('Invalid lexicon format - no lexicon element found');
      }
      console.log('Found lexicon:', lexicon);
      if (!lexicon) {
        throw new Error('Invalid lexicon format');
      }
      // Convert any entry tags to lexeme tags
      console.log('Lexicon structure:', lexicon);
      
      // Defensive programming for array processing
      let entries = [];
      let lexemes = [];
      
      try {
        entries = Array.isArray(lexicon.entry) ? lexicon.entry : lexicon.entry ? [lexicon.entry] : [];
        lexemes = Array.isArray(lexicon.lexeme) ? lexicon.lexeme : lexicon.lexeme ? [lexicon.lexeme] : [];
        
        // Ensure entries and lexemes are arrays
        if (!Array.isArray(entries)) {
          console.warn('Entries is not an array, converting:', entries);
          entries = [];
        }
        if (!Array.isArray(lexemes)) {
          console.warn('Lexemes is not an array, converting:', lexemes);
          lexemes = [];
        }
        
        console.log('Found entries:', entries.length, 'lexemes:', lexemes.length);
      } catch (arrayError) {
        console.error('Error processing entries/lexemes arrays:', arrayError);
        entries = [];
        lexemes = [];
      }
      
      if (entries.length === 0 && lexemes.length === 0) {
        throw new Error('No entries or lexemes found in the lexicon');
      }
      // Combine and convert all entries to lexeme format
      const combinedEntries = [...entries, ...lexemes];
      console.log('Combined entries for processing:', combinedEntries.length);
      
      const parsedEntries = combinedEntries.map((lex: any, index: number) => {
        try {
          console.log(`Processing entry ${index + 1}:`, lex);
          return {
            graphemes: Array.isArray(lex.grapheme)
              ? lex.grapheme.map((g: any) => g['#text'] || g) : lex.grapheme ? [lex.grapheme['#text'] || lex.grapheme] : [],
            alias: lex.alias?.['#text'] || lex.alias || '',
            aliasSayAsType: lex.alias?.['@_interpret-as'] || '',
            phoneme: lex.phoneme?.['#text'] || lex.phoneme || '',
            phonemeSayAsType: lex.phoneme?.['@_interpret-as'] || ''
          };
        } catch (entryError: any) {
          console.error(`Error processing entry ${index + 1}:`, entryError, lex);
          throw new Error(`Error processing entry ${index + 1}: ${entryError.message}`);
        }
      });
      setEntries(parsedEntries);
      setSavedEntries([]); // Mark as unsaved so Save is enabled
      setValidationErrors({}); // Clear validation errors when importing
      setPhonemeInputWarning(null); // Clear phoneme warning when importing
      setCurrentFile(file.name);
      setNewLexiconLang(lexicon['@_xml:lang'] || lexicon['@_lang'] || 'en-US');
      setShowImportSavePrompt(true);
      setShowImportModal(false);
      setPendingImportFile(null);
      clearPanelOnLexiconLoad();
      // Load current settings data to check if this lexicon is published
      await loadSettingsData();
      // Refresh the lexicon list to show the newly imported file
      await refreshLexiconList();
    } catch (e: any) {
      console.error('Error importing lexicon:', e);
      console.error('Error details:', {
        name: e.name,
        message: e.message,
        stack: e.stack,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type
      });
      
      let errorMessage = 'Failed to import lexicon file. ';
      if (e.name === 'NotReadableError') {
        errorMessage += 'File could not be read. Please check if the file is corrupted.';
      } else if (e.message.includes('XML')) {
        errorMessage += 'Invalid XML format. Please check the file structure.';
      } else {
        errorMessage += `Error: ${e.message}`;
      }
      
      setError(errorMessage);
      setShowImportModal(false);
      setPendingImportFile(null);
    }
  };

  // When searchQuery changes, clear right panel if searching, and clear selection when search is cleared
  useEffect(() => {
    setSelectedIndex(null);
    // Clear phoneme warning and timeout when search changes
    if (phonemeWarningTimeoutRef.current) {
      clearTimeout(phonemeWarningTimeoutRef.current);
      phonemeWarningTimeoutRef.current = null;
    }
    setPhonemeInputWarning(null);
  }, [searchQuery]);

  // Clear phoneme warning when selection changes
  useEffect(() => {
    // Clear warning and any pending timeout when selection changes
    if (phonemeWarningTimeoutRef.current) {
      clearTimeout(phonemeWarningTimeoutRef.current);
      phonemeWarningTimeoutRef.current = null;
    }
    setPhonemeInputWarning(null);
  }, [selectedIndex]);

  // Cleanup timeout on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      if (phonemeWarningTimeoutRef.current) {
        clearTimeout(phonemeWarningTimeoutRef.current);
      }
    };
  }, []);

  // Determine if there are unsaved changes
  const hasUnsavedChanges = !deepEqual(entries, savedEntries);

  // Re-validate the selected entry whenever it changes
  useEffect(() => {
    if (selectedIndex !== null && entries[selectedIndex]) {
      // Re-validate the currently selected entry to ensure validation is up to date
      const entry = entries[selectedIndex];
      updateValidationErrors(selectedIndex, entry);
    }
  }, [selectedIndex, entries]);

  // Helper function to find the correct insertion position for alphabetical sorting
  const findInsertionIndex = (entries: LexiconEntry[], newEntry: LexiconEntry): number => {
    const newGrapheme = newEntry.graphemes[0]?.toLowerCase() || '';
    
    for (let i = 0; i < entries.length; i++) {
      const currentGrapheme = entries[i].graphemes[0]?.toLowerCase() || '';
      if (newGrapheme.localeCompare(currentGrapheme) < 0) {
        return i;
      }
    }
    return entries.length; // Insert at end if no smaller entry found
  };

  // SSML validation function - validates entries
  const validateEntry = (entry: LexiconEntry, entryIndex: number): string[] => {
    const errors: string[] = [];
    
    // Always validate when called from updateValidationErrors
    // Only skip validation for existing unmodified entries when doing bulk validation
    const isNew = entry.isNew;
    const isModified = hasEntryBeenModified(entry, entryIndex);
    
    // ALWAYS validate if there are validation errors already - this helps catch issues
    const hasExistingErrors = validationErrors[entryIndex] && validationErrors[entryIndex].length > 0;
    
    // For now, always validate to catch all issues
    // We can optimize later if needed
    // if (!isNew && !isModified && !hasExistingErrors) {
    //   return errors; // Skip validation for existing unmodified entries without errors
    // }
    
    // Debug logging for validation issues - log more details for entries with errors
    if (entryIndex < 10 || hasExistingErrors) { // Log more entries or any with existing errors
      console.log(`Validating entry ${entryIndex}:`, { 
        isNew, 
        isModified, 
        hasExistingErrors,
        entry: JSON.parse(JSON.stringify(entry)), // Deep clone to see actual values
        graphemes: entry.graphemes,
        graphemesLength: entry.graphemes?.length,
        alias: entry.alias,
        phoneme: entry.phoneme
      });
    }
    
    // Rule 1: Must have at least one non-empty grapheme
    const hasValidGrapheme = entry.graphemes && 
                             Array.isArray(entry.graphemes) && 
                             entry.graphemes.length > 0 && 
                             entry.graphemes.some(g => g != null && String(g).trim() !== '' && String(g) !== '*** NEW ENTRY ***');
    if (!hasValidGrapheme) {
      console.log(`Entry ${entryIndex} failed grapheme check:`, { 
        graphemes: entry.graphemes, 
        graphemesType: typeof entry.graphemes,
        graphemesLength: entry.graphemes?.length,
        graphemesArray: Array.isArray(entry.graphemes),
        hasValidGrapheme 
      });
      errors.push('Must have at least one grapheme');
    }
    
    // Rule 2: Must have either alias OR phoneme (SSML requirement)
    // Check both the raw values and trimmed values to handle edge cases
    const aliasValue = entry.alias != null ? String(entry.alias).trim() : '';
    const phonemeValue = entry.phoneme != null ? String(entry.phoneme).trim() : '';
    const hasAlias = aliasValue !== '';
    const hasPhoneme = phonemeValue !== '';
    
    if (!hasAlias && !hasPhoneme) {
      console.log(`Entry ${entryIndex} failed alias/phoneme check:`, { 
        alias: entry.alias,
        aliasType: typeof entry.alias,
        aliasValue,
        phoneme: entry.phoneme,
        phonemeType: typeof entry.phoneme,
        phonemeValue,
        hasAlias,
        hasPhoneme,
        fullEntry: entry
      });
      errors.push('Must have either an alias or phoneme');
    }
    
    // Rule 3: Since we now filter input in real-time, phoneme validation is less strict
    // This rule mainly catches edge cases or entries that were imported/loaded
    // Note: We allow > and < which are commonly used in lexicons for pronunciation guides
    if (hasPhoneme && entry.phoneme) {
      // Use the same regex as the input filter but as a test (not global)
      // The source property gives us the pattern without flags, so we add anchors
      const ipaPattern = new RegExp('^' + VALID_IPA_CHARS_REGEX.source + '+$');
      if (!ipaPattern.test(entry.phoneme)) {
        errors.push('Phoneme contains invalid characters (imported entries may need manual correction)');
      }
    }
    
    return errors;
  };

  // Helper to check if an entry has been modified since loading
  const hasEntryBeenModified = (entry: LexiconEntry, entryIndex: number): boolean => {
    if (entryIndex >= savedEntries.length) return true; // New entry
    const savedEntry = savedEntries[entryIndex];
    if (!savedEntry) return true;
    
    const isModified = !deepEqual(
      { 
        graphemes: entry.graphemes, 
        alias: entry.alias, 
        aliasSayAsType: entry.aliasSayAsType,
        phoneme: entry.phoneme,
        phonemeSayAsType: entry.phonemeSayAsType
      },
      { 
        graphemes: savedEntry.graphemes, 
        alias: savedEntry.alias, 
        aliasSayAsType: savedEntry.aliasSayAsType,
        phoneme: savedEntry.phoneme,
        phonemeSayAsType: savedEntry.phonemeSayAsType
      }
    );
    
    // Debug logging for validation issues
    if (isModified && entryIndex < 5) { // Only log first 5 entries to avoid spam
      console.log(`Entry ${entryIndex} appears modified:`, {
        current: {
          graphemes: entry.graphemes,
          alias: entry.alias,
          phoneme: entry.phoneme
        },
        saved: {
          graphemes: savedEntry.graphemes,
          alias: savedEntry.alias,
          phoneme: savedEntry.phoneme
        }
      });
    }
    
    return isModified;
  };

  // Update validation errors for a specific entry
  const updateValidationErrors = (entryIndex: number, entry: LexiconEntry) => {
    // Always validate - don't skip based on isNew/isModified here
    // We want to catch validation issues even for unmodified entries
    const errors = validateEntry(entry, entryIndex);
    
    console.log(`updateValidationErrors for entry ${entryIndex}:`, {
      errors,
      entryGraphemes: entry.graphemes,
      entryAlias: entry.alias,
      entryPhoneme: entry.phoneme
    });
    
    setValidationErrors(prev => {
      const newErrors = { ...prev };
      if (errors.length > 0) {
        newErrors[entryIndex] = errors;
      } else {
        delete newErrors[entryIndex];
      }
      return newErrors;
    });
  };

  // Restore entry handlers and variables if missing
  const handleNewEntry = () => {
    const newEntry: LexiconEntry = {
      graphemes: ['*** NEW ENTRY ***'],
      alias: '',
      aliasSayAsType: '',
      phoneme: '',
      phonemeSayAsType: '',
      isNew: true
    };
    
    // Find the correct alphabetical position
    const insertIndex = findInsertionIndex(entries, newEntry);
    
    // Insert the new entry at the correct position
    const newEntries = [...entries];
    newEntries.splice(insertIndex, 0, newEntry);
    
    setEntries(newEntries);
    setSelectedIndex(insertIndex);
    
    // Update validation for the new entry
    updateValidationErrors(insertIndex, newEntry);
    
    // Scroll to the newly inserted entry after a brief delay to ensure DOM update
    setTimeout(() => {
      if (entriesListRef.current) {
        // Find the DOM element for the newly inserted entry by looking for the one with matching key
        const entryElement = entriesListRef.current.querySelector(`[data-index="${insertIndex}"]`);
        if (entryElement) {
          entryElement.scrollIntoView({ 
            behavior: 'smooth', 
            block: 'nearest' 
          });
        }
      }
    }, 100);
  };

  const handleDeleteEntry = () => {
    if (selectedIndex !== null) {
      const newEntries = entries.filter((_, idx) => idx !== selectedIndex);
      setEntries(newEntries);
      
      // Update validation errors - remove deleted entry and shift indices
      setValidationErrors(prev => {
        const newErrors: {[index: number]: string[]} = {};
        Object.keys(prev).forEach(indexStr => {
          const index = parseInt(indexStr);
          if (index < selectedIndex) {
            // Keep errors for entries before the deleted one
            newErrors[index] = prev[index];
          } else if (index > selectedIndex) {
            // Shift errors for entries after the deleted one
            newErrors[index - 1] = prev[index];
          }
          // Skip the deleted entry (index === selectedIndex)
        });
        return newErrors;
      });
      
      if (newEntries.length === 0) setSelectedIndex(null);
      else setSelectedIndex(null);
    }
  };

  const handleGraphemeChange = (gIdx: number, value: string) => {
    if (selectedIndex === null) return;
    const updatedEntry = { ...entries[selectedIndex] };
    updatedEntry.graphemes = [...updatedEntry.graphemes];
    updatedEntry.graphemes[gIdx] = value;
    
    // If this is the first grapheme (display name) and it's changed, re-sort the entry
    if (gIdx === 0 && value.trim() !== '' && value !== '*** NEW ENTRY ***') {
      // Remove the entry from its current position
      const entriesWithoutCurrent = entries.filter((_, idx) => idx !== selectedIndex);
      
      // Find the new insertion position
      const insertIndex = findInsertionIndex(entriesWithoutCurrent, updatedEntry);
      
      // Insert the updated entry at the correct position
      const newEntries = [...entriesWithoutCurrent];
      newEntries.splice(insertIndex, 0, updatedEntry);
      
      setEntries(newEntries);
      setSelectedIndex(insertIndex);
      
      // Update validation for the moved entry
      updateValidationErrors(insertIndex, updatedEntry);
      
      // Scroll to the newly positioned entry
      setTimeout(() => {
        if (entriesListRef.current) {
          const entryElement = entriesListRef.current.querySelector(`[data-index="${insertIndex}"]`);
          if (entryElement) {
            entryElement.scrollIntoView({ 
              behavior: 'smooth', 
              block: 'nearest' 
            });
          }
        }
      }, 100);
    } else {
      // For non-first graphemes or empty values, just update in place
      const newEntries = entries.map((entry, idx) => idx === selectedIndex ? updatedEntry : entry);
      setEntries(newEntries);
      
      // Update validation for the current entry
      updateValidationErrors(selectedIndex, updatedEntry);
    }
  };

  const handleAddGrapheme = () => {
    if (selectedIndex === null) return;
    const updatedEntry = { ...entries[selectedIndex] };
    updatedEntry.graphemes = [...updatedEntry.graphemes, ''];
    const newEntries = entries.map((entry, idx) => idx === selectedIndex ? updatedEntry : entry);
    setEntries(newEntries);
  };

  const handleRemoveGrapheme = (gIdx: number) => {
    if (selectedIndex === null) return;
    const updatedEntry = { ...entries[selectedIndex] };
    updatedEntry.graphemes = updatedEntry.graphemes.filter((_, idx) => idx !== gIdx);
    const newEntries = entries.map((entry, idx) => idx === selectedIndex ? updatedEntry : entry);
    setEntries(newEntries);
  };

  const handleAliasChange = (value: string) => {
    if (selectedIndex === null) return;
    const updatedEntry = { ...entries[selectedIndex], alias: value };
    const newEntries = entries.map((entry, idx) => idx === selectedIndex ? updatedEntry : entry);
    setEntries(newEntries);
    
    // Update validation for the current entry
    updateValidationErrors(selectedIndex, updatedEntry);
  };

  const handleAliasSayAsChange = (value: string) => {
    if (selectedIndex === null) return;
    const updatedEntry = { ...entries[selectedIndex], aliasSayAsType: value };
    const newEntries = entries.map((entry, idx) => idx === selectedIndex ? updatedEntry : entry);
    setEntries(newEntries);
    
    // Update validation for the current entry
    updateValidationErrors(selectedIndex, updatedEntry);
  };

  const handlePhonemeSayAsChange = (value: string) => {
    if (selectedIndex === null) return;
    const updatedEntry = { ...entries[selectedIndex], phonemeSayAsType: value };
    const newEntries = entries.map((entry, idx) => idx === selectedIndex ? updatedEntry : entry);
    setEntries(newEntries);
    
    // Update validation for the current entry
    updateValidationErrors(selectedIndex, updatedEntry);
  };

  // Filter and validate phoneme input to only allow SSML-valid IPA characters
  const filterPhonemeInput = (value: string): { filtered: string; hasInvalidChars: boolean } => {
    // Reset regex lastIndex to ensure consistent matching (global regex maintains state)
    VALID_IPA_CHARS_REGEX.lastIndex = 0;
    
    // Filter out any characters that aren't valid IPA
    const filtered = value.match(VALID_IPA_CHARS_REGEX)?.join('') || '';
    const hasInvalidChars = filtered.length !== value.length;
    
    return { filtered, hasInvalidChars };
  };

  const handlePhonemeChange = (value: string) => {
    if (selectedIndex === null) return;
    
    const { filtered, hasInvalidChars } = filterPhonemeInput(value);
    
    const updatedEntries = [...entries];
    updatedEntries[selectedIndex] = {
      ...updatedEntries[selectedIndex],
      phoneme: filtered
    };
    setEntries(updatedEntries);
    updateValidationErrors(selectedIndex, updatedEntries[selectedIndex]);
    
    // Clear any existing warning timeout
    if (phonemeWarningTimeoutRef.current) {
      clearTimeout(phonemeWarningTimeoutRef.current);
    }
    
    // Show warning if invalid characters were removed
    if (hasInvalidChars) {
      setPhonemeInputWarning('Invalid characters removed. Only IPA symbols allowed.');
      phonemeWarningTimeoutRef.current = setTimeout(() => {
        setPhonemeInputWarning(null);
      }, TOAST_DURATION);
    }
  };

  const handlePreview = () => {
    if (selectedIndex === null) return;
    
    const entry = entries[selectedIndex];
    
    // Check if entry is valid (has graphemes and either phoneme or alias)
    const hasGraphemes = entry.graphemes && entry.graphemes.length > 0 && entry.graphemes[0] !== '*** NEW ENTRY ***';
    const hasPhoneme = entry.phoneme && entry.phoneme.trim() !== '';
    const hasAlias = entry.alias && entry.alias.trim() !== '';
    
    if (!hasGraphemes) {
      setToast({ type: 'error', message: 'Please enter graphemes to preview' });
      return;
    }
    
    if (!hasPhoneme && !hasAlias) {
      setToast({ type: 'error', message: 'Please enter either a phoneme or alias to preview' });
      return;
    }



    setPreviewLoading(true);
    
    try {
      // Use phoneme if available, otherwise use alias
      const script = hasPhoneme ? entry.phoneme! : entry.alias!;
      const encodedScript = encodeURIComponent(script);
      
      // Get the sayAs type for the script being used
      const sayAsType = hasPhoneme ? entry.phonemeSayAsType : entry.aliasSayAsType;
      
      // Create a simple filename for the preview
      const filename = `preview_${Date.now()}.mp3`;
      const encodedFilename = encodeURIComponent(filename);
      
      // Construct the TTS URL using the current lexicon's language
      let ttsUrl = `https://web-tts-content-development.dev.eastus.aks.skillsoft.com/?language=${newLexiconLang}&file=${encodedFilename}&script=${encodedScript}`;
      
      // Add lexicon name if available
      if (currentFile) {
        const encodedLexicon = encodeURIComponent(currentFile);
        ttsUrl += `&lexicon=${encodedLexicon}`;
      }
      
      // Add interpret-as parameter if sayAs type is specified
      if (sayAsType && sayAsType.trim() !== '') {
        const encodedSayAs = encodeURIComponent(sayAsType);
        ttsUrl += `&interpret-as=${encodedSayAs}`;
      }
      
      // Add autoPlay parameter for the updated TTS app
      ttsUrl += '&autoPlay=true';
      
      // Debug: Log the generated URL
      console.log('Generated TTS URL:', ttsUrl);
      
      // Set the URL and show the floating preview
      setPreviewUrl(ttsUrl);
      setShowFloatingPreview(true);
    } catch (error) {
      setToast({ type: 'error', message: 'Failed to open preview' });
    } finally {
      setPreviewLoading(false);
    }
  };

  // Filtered entries based on search
  const filteredEntries = searchQuery.trim() === ''
    ? entries.map((entry, idx) => ({ entry, originalIndex: idx }))
    : entries
        .map((entry, idx) => ({ entry, originalIndex: idx }))
        .filter(({ entry }) => {
          const q = searchQuery.toLowerCase();
          return (
            entry.graphemes.some(g => g.toLowerCase().includes(q)) ||
            (entry.alias && entry.alias.toLowerCase().includes(q)) ||
            (entry.phoneme && entry.phoneme.toLowerCase().includes(q))
          );
        });

  // Hide previews when entry selection changes
  useEffect(() => {
    if (showEmbeddedPreview) {
      setShowEmbeddedPreview(false);
    }
    if (showFloatingPreview) {
      if (previewTimeoutRef.current) {
        clearTimeout(previewTimeoutRef.current);
        previewTimeoutRef.current = null;
      }
      setShowFloatingPreview(false);
    }
  }, [selectedIndex]);

  // Cleanup preview timeout on unmount
  useEffect(() => {
    return () => {
      if (previewTimeoutRef.current) {
        clearTimeout(previewTimeoutRef.current);
      }
    };
  }, []);





  // Save lexicon handler (restore if missing)
  const handleSaveLexicon = async () => {
    console.log('handleSaveLexicon called', { currentFile, isOnlyPlaceholder, hasUnsavedChanges, validationErrorsCount: Object.keys(validationErrors).length });
    
    if (!currentFile) {
      console.log('No current file, showing save as modal');
      setShowSaveAsModal(true);
      return;
    }
    if (isOnlyPlaceholder) {
      console.log('Only placeholder entry, cannot save');
      setShowToast(true);
      setToastMessage('Cannot save: Add at least one real entry.');
      setToastType('error');
      return;
    }
    
    // Check for validation errors before saving
    const hasValidationErrors = Object.keys(validationErrors).length > 0;
    if (hasValidationErrors) {
      const errorCount = Object.keys(validationErrors).length;
      const entryWord = errorCount === 1 ? 'entry' : 'entries';
      console.log('Validation errors found, cannot save', { errorCount, validationErrors });
      
      // Build detailed error message showing which entries have errors
      const errorDetails = Object.entries(validationErrors)
        .map(([index, errors]) => {
          const entryIndex = parseInt(index);
          const entry = entries[entryIndex];
          const grapheme = entry?.graphemes?.[0] || `Entry ${entryIndex + 1}`;
          const errorList = Array.isArray(errors) ? errors.join(', ') : String(errors);
          return { index: entryIndex, grapheme, errors: errorList };
        })
        .sort((a, b) => a.index - b.index); // Sort by index
      
      // Select and scroll to the first entry with errors
      const firstErrorIndex = errorDetails[0].index;
      setSelectedIndex(firstErrorIndex);
      
      // Scroll to the entry in the list
      setTimeout(() => {
        const entryElement = document.querySelector(`[data-index="${firstErrorIndex}"]`);
        if (entryElement) {
          entryElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 100);
      
      // Build error message - show first 3 entries, then summarize if more
      let errorMessage = `Cannot save: ${errorCount} ${entryWord} with validation errors. `;
      if (errorDetails.length <= 3) {
        // Show all errors if 3 or fewer
        errorMessage += errorDetails.map(e => `"${e.grapheme}": ${e.errors}`).join('; ');
      } else {
        // Show first 3, then summarize
        errorMessage += errorDetails.slice(0, 3).map(e => `"${e.grapheme}": ${e.errors}`).join('; ');
        errorMessage += `; and ${errorDetails.length - 3} more. See selected entry for details.`;
      }
      
      setShowToast(true);
      setToastMessage(errorMessage);
      setToastType('error');
      return;
    }
    
    try {
      const xml = buildXML();
      console.log('Attempting to save lexicon:', currentFile, 'XML length:', xml.length);
      await saveLexicon(currentFile, xml);
      
      // Only update savedEntries if save was successful
      // Remove isNew flag from all entries when saving
      const cleanedEntries = entries.map(entry => ({
        graphemes: entry.graphemes,
        alias: entry.alias,
        aliasSayAsType: entry.aliasSayAsType,
        phoneme: entry.phoneme,
        phonemeSayAsType: entry.phonemeSayAsType
      }));
      setSavedEntries([...cleanedEntries]); // Update savedEntries to match current entries
      setEntries([...cleanedEntries]); // Update entries to remove isNew flags
      setValidationErrors({}); // Clear all validation errors after successful save
      setPhonemeInputWarning(null); // Clear phoneme warning after successful save
      setShowToast(true);
      setToastMessage('Lexicon saved successfully');
      setToastType('success');
      console.log('Save completed successfully, savedEntries updated');
    } catch (error: any) {
      console.error('Error saving lexicon:', error);
      setShowToast(true);
      setToastMessage(`Error saving lexicon: ${error.message || 'Unknown error'}`);
      setToastType('error');
    }
  };

  // Export lexicon handler with format selection
  const handleExportLexicon = async () => {
    if (!currentFile) {
      setShowToast(true);
      setToastMessage('No file selected');
      setToastType('error');
      return;
    }

    setShowExportFormatModal(true);
  };

  const handleExportFormat = (format: 'xml' | 'tsv') => {
    setShowExportFormatModal(false);
    
    try {
      let content: string;
      let mimeType: string;
      let extension: string;
      
      if (format === 'xml') {
        content = buildXML();
        mimeType = 'text/xml';
        extension = '.xml';
      } else {
        content = buildCSV();
        mimeType = 'text/csv; charset=utf-8';
        extension = '.csv';
      }
      
      // For CSV files, ensure proper UTF-8 encoding
      let blob: Blob;
      if (format === 'tsv') {
        // Add UTF-8 BOM for Excel compatibility
        const BOM = '\uFEFF';
        const contentWithBOM = BOM + content;
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(contentWithBOM);
        blob = new Blob([utf8Bytes], { type: mimeType });
      } else {
        // For CSV, add BOM for Excel compatibility
        const BOM = '\uFEFF';
        const contentWithBOM = BOM + content;
        const encoder = new TextEncoder();
        const utf8Bytes = encoder.encode(contentWithBOM);
        blob = new Blob([utf8Bytes], { type: mimeType });
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      // Generate filename based on current file and format
      const baseName = currentFile.replace(/\.(xml|tsv)$/i, '');
      a.download = `${baseName}${extension}`;
      
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setShowToast(true);
      setToastMessage(`Lexicon exported as ${format.toUpperCase()}`);
      setToastType('success');
    } catch (error) {
      console.error('Error exporting lexicon:', error);
      setShowToast(true);
      setToastMessage('Error exporting lexicon');
      setToastType('error');
    }
  };

  // Restore handleCreateNewLexicon if missing
  const handleCreateNewLexicon = async () => {
    if (!newLexiconName.trim()) {
      setNewLexiconError('Please enter a lexicon name');
      return;
    }

    if (!newLexiconLang) {
      setNewLexiconError('Please select a language');
      return;
    }

    // Add .xml extension if not present
    let finalName = newLexiconName.trim();
    if (!finalName.toLowerCase().endsWith('.xml')) {
      finalName += '.xml';
    }

    // Validate the name format (only check for valid characters now since we handle the extension)
    if (!/^[a-zA-Z0-9-_]+\.xml$/.test(finalName)) {
      setNewLexiconError('Lexicon name must contain only letters, numbers, hyphens, and underscores');
      return;
    }

    setNewLexiconError(null);
    setShowNewLexiconModal(false);

    // Create a new lexicon with a master entry
    const newEntry: LexiconEntry = {
      graphemes: ['*** NEW ENTRY ***'],
      alias: '',
      phoneme: '',
      isNew: true
    };

    // Clear any existing state and set up the new lexicon
    setEntries([newEntry]);
    setSavedEntries([]); // Mark as unsaved so Save is enabled
    setValidationErrors({}); // Clear any previous validation errors
    setPhonemeInputWarning(null); // Clear phoneme warning for new lexicon
    setSelectedIndex(0);
    setCurrentFile(finalName);
    // Set both language states
    setNewLexiconLang(newLexiconLang);
    setSelectedLanguage(newLexiconLang);

    // Add spoof entry to blobList if not present
    setBlobList((prev) => prev.includes(finalName) ? prev : [finalName, ...prev]);
    clearPanelOnLexiconLoad();
    // Load current settings data to check if this lexicon is published
    await loadSettingsData();
    // Do NOT call any save/upload logic here.
  };

  // Show toast for 3 seconds
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), TOAST_DURATION);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // When loading a new lexicon (open/import/duplicate/new), clear right panel
  const clearPanelOnLexiconLoad = () => setSelectedIndex(null);

  // Save As handler (updated for overwrite check)
  const handleSaveAsClick = () => {
    setSaveAsFilename(currentFile || '');
    setShowSaveAsModal(true);
  };

  const handleSaveAsConfirm = async () => {
    let newFilename = saveAsFilename.trim();
    if (!newFilename) {
      setSaveAsError('Filename cannot be empty');
      return;
    }

    // Ensure filename ends with .xml (lowercase)
    if (!newFilename.toLowerCase().endsWith('.xml')) {
      newFilename += '.xml';
    } else {
      newFilename = newFilename.slice(0, -4) + '.xml';
    }

    if (newFilename.includes('/') || newFilename.includes('\\')) {
      setSaveAsError('Filename cannot contain slashes');
      return;
    }

    if (newFilename === currentFile) {
      setShowSaveAsModal(false);
      return;
    }

    const existingFiles = await listLexiconFiles();
    if (existingFiles.includes(newFilename)) {
      setOverwriteFilename(newFilename);
      setShowOverwriteModal(true);
      setShowSaveAsModal(false);
      return;
    }

    // Duplicate the current blob and save it as the new filename
    const xml = buildXML();
    await saveLexicon(newFilename, xml);
    setCurrentFile(newFilename);
    setShowSaveAsModal(false);
    setSaveAsError('');
    // Load current settings data to check if this lexicon is published
    await loadSettingsData();
    // Refresh lexicon list to show the new file
    await refreshLexiconList();
  };

  // Overwrite confirm
  const handleOverwriteConfirm = async () => {
    if (!overwriteFilename) return;

    // Duplicate the blob and save it as the new filename
    const xml = buildXML();
    await saveLexicon(overwriteFilename, xml);
    setCurrentFile(overwriteFilename);
    setShowOverwriteModal(false);
    setOverwriteFilename('');
    // Load current settings data to check if this lexicon is published
    await loadSettingsData();
    // Refresh lexicon list to show the updated file
    await refreshLexiconList();
  };

  // Prevent saving empty lexicon
  const isOnlyPlaceholder = entries.length === 1 && entries[0].graphemes.length === 1 && entries[0].graphemes[0] === '*** NEW ENTRY ***' && !entries[0].alias && !entries[0].phoneme;
  const isEmptyLexicon = entries.length === 0 || isOnlyPlaceholder;

  // Ensure modals close on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showSaveAsModal) setShowSaveAsModal(false);
        if (showOverwriteModal) setShowOverwriteModal(false);
        if (showImportModal) setShowImportModal(false);
        if (showImportSavePrompt) setShowImportSavePrompt(false);
        if (showNewLexiconModal) setShowNewLexiconModal(false);
        if (showMergeModal) setShowMergeModal(false);
        if (showConflictResolution) setShowConflictResolution(false);
        if (showPreviewModal) setShowPreviewModal(false);
        if (showPublishModal) setShowPublishModal(false);
        if (showRemoveModal) setShowRemoveModal(false);
        if (showExportFormatModal) setShowExportFormatModal(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showSaveAsModal, showOverwriteModal, showImportModal, showImportSavePrompt, showNewLexiconModal, showMergeModal, showConflictResolution, showPreviewModal, showPublishModal, showRemoveModal, showExportFormatModal]);

  // Add useEffect for handling clicks outside tooltips
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (activeTooltip) {
        setActiveTooltip(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [activeTooltip]);

  const buildXML = () => {
    const NS = 'http://www.w3.org/2005/01/pronunciation-lexicon';
    const doc = document.implementation.createDocument('', '', null);
    const root = doc.createElementNS(NS, 'lexicon');
    root.setAttribute('version', '1.0');
    root.setAttribute('xml:lang', newLexiconLang);
    root.setAttribute('xmlns', NS);
    root.setAttribute('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance');
    root.setAttribute('xsi:schemaLocation', 'http://www.w3.org/2005/01/pronunciation-lexicon http://www.w3.org/TR/2007/CR-pronunciation-lexicon-20071212/pls.xsd');
    root.setAttribute('alphabet', 'ipa');

    // Build lexicon entries with proper PLS format
    // The interpret-as attribute is valid on alias and phoneme elements per PLS specification
    // This ensures compatibility with TTS engines that support SSML say-as functionality
    // For engines that don't support interpret-as, the attribute is simply ignored

    // Always use lexeme tags for lexicon entries to maintain consistency and prevent errors
    entries.forEach(entry => {
      const lexemeElement = doc.createElementNS(NS, 'lexeme');
      entry.graphemes.forEach(grapheme => {
        const graphemeElement = doc.createElementNS(NS, 'grapheme');
        graphemeElement.textContent = grapheme;
        lexemeElement.appendChild(graphemeElement);
      });
      if (entry.alias) {
        const aliasElement = doc.createElementNS(NS, 'alias');
        aliasElement.textContent = entry.alias;
        // Only add interpret-as if it's a valid say-as type and not empty
        if (entry.aliasSayAsType && entry.aliasSayAsType.trim() && entry.aliasSayAsType !== '') {
          // Validate the say-as type against our known options
          const validSayAsTypes = SAY_AS_OPTIONS.map(opt => opt.value).filter(val => val !== '');
          if (validSayAsTypes.includes(entry.aliasSayAsType)) {
            aliasElement.setAttribute('interpret-as', entry.aliasSayAsType);
          }
        }
        lexemeElement.appendChild(aliasElement);
      }
      if (entry.phoneme) {
        const phonemeElement = doc.createElementNS(NS, 'phoneme');
        phonemeElement.textContent = entry.phoneme;
        // Only add interpret-as if it's a valid say-as type and not empty
        if (entry.phonemeSayAsType && entry.phonemeSayAsType.trim() && entry.phonemeSayAsType !== '') {
          // Validate the say-as type against our known options
          const validSayAsTypes = SAY_AS_OPTIONS.map(opt => opt.value).filter(val => val !== '');
          if (validSayAsTypes.includes(entry.phonemeSayAsType)) {
            phonemeElement.setAttribute('interpret-as', entry.phonemeSayAsType);
          }
        }
        lexemeElement.appendChild(phonemeElement);
      }
      root.appendChild(lexemeElement);
    });

    doc.appendChild(root);
    const serializer = new XMLSerializer();
    const xmlString = serializer.serializeToString(doc);
    // Ensure XML declaration is present
    const xmlWithDeclaration = xmlString.startsWith('<?xml') ? xmlString : '<?xml version="1.0" encoding="utf-8"?>\n' + xmlString;
    return xmlWithDeclaration;
  };

  const buildTSV = () => {
    const header = 'grapheme\talias\talias_say_as\tphoneme\tphoneme_say_as';
    const rows: string[] = [header];
    
    entries.forEach(entry => {
      // Create one row per grapheme
      entry.graphemes.forEach(grapheme => {
        const row = [
          grapheme,
          entry.alias || '',
          entry.aliasSayAsType || '',
          entry.phoneme || '',
          entry.phonemeSayAsType || ''
        ].join('\t');
        rows.push(row);
      });
    });
    
    const result = rows.join('\n');
    console.log('Generated TSV content:', result);
    console.log('TSV lines:', rows);
    return result;
  };

  const buildCSV = () => {
    const header = 'grapheme,alias,alias_say_as,phoneme,phoneme_say_as';
    const rows: string[] = [header];
    
    // Helper function to properly escape CSV values
    const escapeCSV = (value: string): string => {
      if (!value) return '';
      
      // If value contains comma, quote, or newline, wrap in quotes and escape internal quotes
      if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return '"' + value.replace(/"/g, '""') + '"';
      }
      return value;
    };
    
    entries.forEach(entry => {
      // Create one row per grapheme
      entry.graphemes.forEach(grapheme => {
        const row = [
          escapeCSV(grapheme),
          escapeCSV(entry.alias || ''),
          escapeCSV(entry.aliasSayAsType || ''),
          escapeCSV(entry.phoneme || ''),
          escapeCSV(entry.phonemeSayAsType || '')
        ].join(',');
        rows.push(row);
      });
    });
    
    const result = rows.join('\n');
    console.log('Generated CSV content:', result);
    console.log('CSV lines:', rows);
    return result;
  };

  const parseTSV = (tsvContent: string): LexiconEntry[] => {
    // Remove UTF-8 BOM if present
    const cleanContent = tsvContent.startsWith('\uFEFF') ? tsvContent.slice(1) : tsvContent;
    const lines = cleanContent.split('\n');
    const dataLines = lines.filter(line => !line.trim().startsWith('#') && line.trim());
    
    if (dataLines.length < 2) {
      throw new Error('TSV file must have at least a header row and one data row');
    }
    
    const headerLine = dataLines[0];
    const headers = headerLine.split('\t');
    
    // Validate headers
    const expectedHeaders = ['grapheme', 'alias', 'alias_say_as', 'phoneme', 'phoneme_say_as'];
    if (!expectedHeaders.every(header => headers.includes(header))) {
      throw new Error('TSV file must have the correct headers: grapheme, alias, alias_say_as, phoneme, phoneme_say_as');
    }
    
    const graphemeIndex = headers.indexOf('grapheme');
    const aliasIndex = headers.indexOf('alias');
    const aliasSayAsIndex = headers.indexOf('alias_say_as');
    const phonemeIndex = headers.indexOf('phoneme');
    const phonemeSayAsIndex = headers.indexOf('phoneme_say_as');
    
    // Group rows by grapheme to reconstruct LexiconEntry objects
    const entryMap = new Map<string, LexiconEntry>();
    
    dataLines.slice(1).forEach(line => {
      const columns = line.split('\t');
      const grapheme = columns[graphemeIndex]?.trim() || '';
      const alias = columns[aliasIndex]?.trim() || '';
      const aliasSayAs = columns[aliasSayAsIndex]?.trim() || '';
      const phoneme = columns[phonemeIndex]?.trim() || '';
      const phonemeSayAs = columns[phonemeSayAsIndex]?.trim() || '';
      
      if (!grapheme) return; // Skip empty rows
      
      // Create a key based on the entry content (excluding grapheme)
      const entryKey = `${alias}|${aliasSayAs}|${phoneme}|${phonemeSayAs}`;
      
      if (!entryMap.has(entryKey)) {
        entryMap.set(entryKey, {
          graphemes: [],
          alias: alias || undefined,
          aliasSayAsType: aliasSayAs || undefined,
          phoneme: phoneme || undefined,
          phonemeSayAsType: phonemeSayAs || undefined
        });
      }
      
      entryMap.get(entryKey)!.graphemes.push(grapheme);
    });
    
    return Array.from(entryMap.values());
  };

  const parseCSV = (csvContent: string): LexiconEntry[] => {
    // Remove UTF-8 BOM if present
    const cleanContent = csvContent.startsWith('\uFEFF') ? csvContent.slice(1) : csvContent;
    const lines = cleanContent.split('\n');
    const dataLines = lines.filter(line => !line.trim().startsWith('#') && line.trim());
    
    if (dataLines.length < 2) {
      throw new Error('CSV file must have at least a header row and one data row');
    }
    
    // Helper function to parse CSV line with proper quote handling
    const parseCSVLine = (line: string): string[] => {
      const result: string[] = [];
      let current = '';
      let inQuotes = false;
      let i = 0;
      
      while (i < line.length) {
        const char = line[i];
        const nextChar = line[i + 1];
        
        if (char === '"') {
          if (inQuotes && nextChar === '"') {
            // Escaped quote
            current += '"';
            i += 2;
          } else {
            // Toggle quote state
            inQuotes = !inQuotes;
            i++;
          }
        } else if (char === ',' && !inQuotes) {
          // End of field
          result.push(current);
          current = '';
          i++;
        } else {
          current += char;
          i++;
        }
      }
      
      // Add the last field
      result.push(current);
      return result;
    };
    
    const headerLine = dataLines[0];
    const headers = parseCSVLine(headerLine);
    
    // Validate headers
    const expectedHeaders = ['grapheme', 'alias', 'alias_say_as', 'phoneme', 'phoneme_say_as'];
    if (!expectedHeaders.every(header => headers.includes(header))) {
      throw new Error('CSV file must have the correct headers: grapheme, alias, alias_say_as, phoneme, phoneme_say_as');
    }
    
    const graphemeIndex = headers.indexOf('grapheme');
    const aliasIndex = headers.indexOf('alias');
    const aliasSayAsIndex = headers.indexOf('alias_say_as');
    const phonemeIndex = headers.indexOf('phoneme');
    const phonemeSayAsIndex = headers.indexOf('phoneme_say_as');
    
    // Group rows by grapheme to reconstruct LexiconEntry objects
    const entryMap = new Map<string, LexiconEntry>();
    
    dataLines.slice(1).forEach(line => {
      const columns = parseCSVLine(line);
      const grapheme = columns[graphemeIndex]?.trim() || '';
      const alias = columns[aliasIndex]?.trim() || '';
      const aliasSayAs = columns[aliasSayAsIndex]?.trim() || '';
      const phoneme = columns[phonemeIndex]?.trim() || '';
      const phonemeSayAs = columns[phonemeSayAsIndex]?.trim() || '';
      
      if (!grapheme) return; // Skip empty rows
      
      // Create a key based on the entry content (excluding grapheme)
      const entryKey = `${alias}|${aliasSayAs}|${phoneme}|${phonemeSayAs}`;
      
      if (!entryMap.has(entryKey)) {
        entryMap.set(entryKey, {
          graphemes: [],
          alias: alias || undefined,
          aliasSayAsType: aliasSayAs || undefined,
          phoneme: phoneme || undefined,
          phonemeSayAsType: phonemeSayAs || undefined
        });
      }
      
      entryMap.get(entryKey)!.graphemes.push(grapheme);
    });
    
    return Array.from(entryMap.values());
  };


  const parseXML = (doc: Document): LexiconEntry[] => {
    const entries: LexiconEntry[] = [];
    const entryElements = doc.getElementsByTagName('lexeme');

    for (let i = 0; i < entryElements.length; i++) {
      const entry = entryElements[i];
      const graphemes: string[] = [];
      const graphemeElements = entry.getElementsByTagName('grapheme');
      for (let j = 0; j < graphemeElements.length; j++) {
        graphemes.push(graphemeElements[j].textContent || '');
      }

      const aliasElement = entry.getElementsByTagName('alias')[0];
      const phonemeElement = entry.getElementsByTagName('phoneme')[0];

      entries.push({
        graphemes,
        alias: aliasElement?.textContent || '',
        aliasSayAsType: aliasElement?.getAttribute('interpret-as') || '',
        phoneme: phonemeElement?.textContent || '',
        phonemeSayAsType: phonemeElement?.getAttribute('interpret-as') || ''
      });
    }

    return entries;
  };

  const listLexiconFiles = async (): Promise<string[]> => {
    try {
      const response = await fetch('/api/list-lexicons');
      if (!response.ok) {
        throw new Error('Failed to list lexicons');
      }
      const files = await response.json();
      return files;
    } catch (error) {
      console.error('Error listing lexicons:', error);
      return [];
    }
  };


  // Helper function to safely find language by ID
  const findLanguageById = (id: string) => {
    try {
      // Ensure LANGUAGES is defined and is an array
      if (!LANGUAGES || !Array.isArray(LANGUAGES)) {
        console.error('LANGUAGES is not properly initialized:', typeof LANGUAGES, LANGUAGES);
        return null;
      }
      return LANGUAGES.find(l => l && l.id === id) || null;
    } catch (error) {
      console.error('Error finding language by ID:', error, 'ID:', id);
      return null;
    }
  };

  // Language list from settings.xml - with defensive programming
  const LANGUAGES: Array<{id: string, name: string}> = [
    { id: 'en-US', name: 'English (United States)' },
    { id: 'en-GB', name: 'English (United Kingdom)' },
    { id: 'en-CA', name: 'English (Canada)' },
    { id: 'en-AU', name: 'English (Australia)' },
    { id: 'en-NZ', name: 'English (New Zealand)' },
    { id: 'en-IN', name: 'English (India)' },
    { id: 'en-IE', name: 'English (Ireland)' },
    { id: 'zh-CN', name: 'Chinese (Mandarin, Simplified)' },
    { id: 'fr-CA', name: 'French (Canada)' },
    { id: 'fr-FR', name: 'French (France)' },
    { id: 'de-DE', name: 'German (Germany)' },
    { id: 'ja-JP', name: 'Japanese (Japan)' },
    { id: 'pt-BR', name: 'Portuguese (Brazil)' },
    { id: 'es-MX', name: 'Spanish (Latin America)' },
    { id: 'es-ES', name: 'Spanish (Castilian)' },
    { id: 'es-DO', name: 'Spanish (Dominican Republic)' }, // Added this entry
    { id: 'nl-NL', name: 'Dutch (Netherlands)' },
    { id: 'it-IT', name: 'Italian (Italy)' },
    { id: 'ko-KR', name: 'Korean (Korea)' },
    { id: 'id-ID', name: 'Indonesian (Indonesia)' },
    { id: 'ms-MY', name: 'Malay (Malaysia)' },
    { id: 'zh-HK', name: 'Chinese (Cantonese, Traditional)' },
    { id: 'cs-CZ', name: 'Czech (Czech)' },
    { id: 'da-DK', name: 'Danish (Denmark)' },
    { id: 'fi-FI', name: 'Finnish (Finland)' },
    { id: 'el-GR', name: 'Greek (Greece)' },
    { id: 'hi-IN', name: 'Hindi (India)' },
    { id: 'hu-HU', name: 'Hungarian (Hungary)' },
    { id: 'nb-NO', name: 'Norwegian (Norway)' },
    { id: 'pl-PL', name: 'Polish (Poland)' },
    { id: 'ro-RO', name: 'Romanian (Romania)' },
    { id: 'ru-RU', name: 'Russian (Russia)' },
    { id: 'sv-SE', name: 'Swedish (Sweden)' },
    { id: 'th-TH', name: 'Thai (Thailand)' },
    { id: 'tr-TR', name: 'Turkish (Turkey)' },
    { id: 'vi-VN', name: 'Vietnamese (Vietnam)' },
    { id: 'bg-BG', name: 'Bulgarian (Bulgaria)' },
    { id: 'ar-EG', name: 'Arabic (Egypt)' },
  ];

  // Add merge handlers before existing handlers
  const handleMergeClick = () => {
    if (!currentFile) {
      setToast({ type: 'error', message: 'Please open a master lexicon first' });
      return;
    }
    setShowMergeModal(true);
  };

  const handleMergeFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setMergeFile(file);
      processMergeFile(file);
    }
    // Reset input
    e.target.value = '';
  };

  const processMergeFile = async (file: File) => {
    // Reset error states
    setMergeErrors([]);
    setMergeDetailedErrors([]);
    
    try {
      const text = await file.text();
      const lines = text.split('\n');
      
      // First, try to parse the XML to check for basic structure issues
      const parser = new XMLParser({ 
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        textNodeName: "#text"
      });
      
      let xml;
      try {
        xml = parser.parse(text);
      } catch (err: any) {
        console.error('Error parsing XML:', err);
        
        // Try to extract line number from error message if available
        let lineNumber = null;
        if (err.message && err.message.includes('line')) {
          const lineMatch = err.message.match(/line (\d+)/i);
          if (lineMatch) {
            lineNumber = parseInt(lineMatch[1]);
          }
        }
        
        setMergeDetailedErrors([{
          lineNumber: lineNumber || undefined,
          errorType: 'xml_parse',
          message: 'XML parsing failed - the file structure is malformed',
          suggestion: 'Check that the file is valid XML with proper opening and closing tags'
        }]);
        setMergeErrors(['The uploaded XML file is malformed or invalid.']);
        return;
      }
      
      if (!xml || !xml.lexicon) {
        setMergeDetailedErrors([{
          errorType: 'invalid_entry',
          message: 'Invalid lexicon format - no lexicon element found',
          suggestion: 'Ensure the file contains a valid lexicon structure with <lexicon> root element'
        }]);
        setMergeErrors(['Invalid lexicon format']);
        return;
      }
      
      // Get language from merge file
      const mergeFileLang = xml.lexicon['@_xml:lang'] || xml.lexicon['@_lang'] || 'en-US';
      setMergeLanguage(mergeFileLang);
      setMergeFileName(file.name);
      
      // Check language compatibility
      if (mergeFileLang !== newLexiconLang) {
        setMergeDetailedErrors([{
          errorType: 'language_mismatch',
          message: `Language mismatch: Master lexicon is ${newLexiconLang}, but merge file is ${mergeFileLang}`,
          suggestion: 'Upload a lexicon file with the same language as your master lexicon'
        }]);
        setMergeErrors([`Language mismatch: Master lexicon is ${newLexiconLang}, but merge file is ${mergeFileLang}`]);
        return;
      }
      
      // Parse entries with detailed error tracking
      const mergeEntries = Array.isArray(xml.lexicon.entry)
        ? xml.lexicon.entry
        : xml.lexicon.entry ? [xml.lexicon.entry] : [];
      const mergeLexemes = Array.isArray(xml.lexicon.lexeme)
        ? xml.lexicon.lexeme
        : xml.lexicon.lexeme ? [xml.lexicon.lexeme] : [];
      
      const allEntries = [...mergeEntries, ...mergeLexemes];
      const parsedMergeEntries: LexiconEntry[] = [];
      const detailedErrors: Array<{
        lineNumber?: number;
        entryContent?: string;
        errorType: 'xml_parse' | 'invalid_entry' | 'missing_element' | 'invalid_character' | 'language_mismatch' | 'general';
        message: string;
        suggestion?: string;
      }> = [];
      
      // Process each entry individually to catch specific errors
      allEntries.forEach((lex: any, index: number) => {
        try {
          // Extract graphemes
          let graphemes: string[] = [];
          if (Array.isArray(lex.grapheme)) {
            graphemes = lex.grapheme.map((g: any) => {
              const graphemeText = g['#text'] || g;
              if (typeof graphemeText !== 'string') {
                throw new Error(`Invalid grapheme format at entry ${index + 1}`);
              }
              return graphemeText;
            });
          } else if (lex.grapheme) {
            const graphemeText = lex.grapheme['#text'] || lex.grapheme;
            if (typeof graphemeText !== 'string') {
              throw new Error(`Invalid grapheme format at entry ${index + 1}`);
            }
            graphemes = [graphemeText];
          }
          
          // Validate graphemes are not empty
          if (graphemes.length === 0) {
            throw new Error(`Entry ${index + 1} has no graphemes`);
          }
          
          // Check for empty or invalid graphemes
          const invalidGraphemes = graphemes.filter(g => !g || g.trim() === '');
          if (invalidGraphemes.length > 0) {
            throw new Error(`Entry ${index + 1} has empty graphemes`);
          }
          
          // Extract alias
          let alias = '';
          if (lex.alias) {
            alias = lex.alias['#text'] || lex.alias || '';
            if (typeof alias !== 'string') {
              throw new Error(`Invalid alias format at entry ${index + 1}`);
            }
          }
          
          // Extract phoneme
          let phoneme = '';
          if (lex.phoneme) {
            phoneme = lex.phoneme['#text'] || lex.phoneme || '';
            if (typeof phoneme !== 'string') {
              throw new Error(`Invalid phoneme format at entry ${index + 1}`);
            }
          }
          
          // Validate that entry has either alias or phoneme
          if (!alias && !phoneme) {
            throw new Error(`Entry ${index + 1} must have either an alias or phoneme`);
          }
          
          // Check for both pronunciations and add warning
          if (alias && phoneme) {
            console.warn(`Entry ${index + 1} has both IPA and Alias pronunciations. IPA will take priority in TTS.`);
          }
          
          // Check for truly problematic characters in graphemes (XML-breaking characters)
          const problematicChars = graphemes.join('').match(/["&]/g);
          if (problematicChars) {
            throw new Error(`Entry ${index + 1} contains problematic characters: ${problematicChars.join(', ')}`);
          }
          
          // Check for other common issues in German lexicon files
          const hasControlChars = graphemes.some(g => /[\u0000-\u001F\u007F]/.test(g));
          if (hasControlChars) {
            throw new Error(`Entry ${index + 1} contains control characters that may cause issues`);
          }
          
          // Check for extremely long graphemes (potential parsing issues)
          const longGraphemes = graphemes.filter(g => g.length > 100);
          if (longGraphemes.length > 0) {
            throw new Error(`Entry ${index + 1} has unusually long graphemes (${longGraphemes[0].length} characters)`);
          }
          
          // Successfully parsed entry
          parsedMergeEntries.push({
            graphemes,
            alias,
            phoneme
          });
          
        } catch (entryError: any) {
          // Find the line number for this entry by searching in the original text
          let lineNumber: number | undefined;
          
          // Try to find the line containing this entry
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(lex.grapheme?.['#text'] || lex.grapheme || '')) {
              lineNumber = i + 1;
              break;
            }
          }
          
          detailedErrors.push({
            lineNumber,
            entryContent: `Graphemes: ${JSON.stringify(lex.grapheme)}, Alias: ${lex.alias || 'none'}, Phoneme: ${lex.phoneme || 'none'}`,
            errorType: 'invalid_entry',
            message: entryError.message,
            suggestion: 'Check that the entry has valid graphemes and either an alias or phoneme'
          });
        }
      });
      
      // Set the results
      setMergeFileContent(parsedMergeEntries);
      setMergeDetailedErrors(detailedErrors);
      
      // Analyze merge preview to show potential issues
      analyzeMergePreview(parsedMergeEntries);
      
      if (detailedErrors.length > 0) {
        setMergeErrors([`Found ${detailedErrors.length} problematic entries in the merge file`]);
      } else {
        setMergeErrors([]);
      }
      
      // Only proceed with merge analysis if there are no errors
      if (detailedErrors.length === 0 && parsedMergeEntries.length > 0) {
        analyzeConflicts(parsedMergeEntries);
      } else if (detailedErrors.length > 0) {
        // Don't proceed with merge if there are errors - show them clearly
        setToast({ 
          type: 'error', 
          message: `Cannot proceed with merge: ${detailedErrors.length} entries have errors that must be fixed first` 
        });
      }
      
    } catch (error: any) {
      console.error('Error processing merge file:', error);
      setMergeDetailedErrors([{
        errorType: 'general',
        message: 'Unexpected error while processing the merge file',
        suggestion: 'Please check the file format and try again'
      }]);
      setMergeErrors(['Failed to process the merge file']);
    }
  };

  // Helper function to check if two entries are phonetically identical (ignoring case)
  const arePhoneticallyIdentical = (entry1: LexiconEntry, entry2: LexiconEntry): boolean => {
    const graphemes1 = entry1.graphemes.map(g => g.toLowerCase()).sort();
    const graphemes2 = entry2.graphemes.map(g => g.toLowerCase()).sort();
    return JSON.stringify(graphemes1) === JSON.stringify(graphemes2) &&
           entry1.phoneme === entry2.phoneme;
  };

  // Helper function to check if entries are identical (case-insensitive for graphemes and aliases)
  const areIdentical = (entry1: LexiconEntry, entry2: LexiconEntry): boolean => {
    const graphemes1 = entry1.graphemes.map(g => g.toLowerCase()).sort();
    const graphemes2 = entry2.graphemes.map(g => g.toLowerCase()).sort();
    return JSON.stringify(graphemes1) === JSON.stringify(graphemes2) &&
           entry1.alias?.toLowerCase() === entry2.alias?.toLowerCase() &&
           entry1.phoneme === entry2.phoneme;
  };

  // Pre-merge validation function to analyze potential issues before merging
  const analyzeMergePreview = (mergeEntries: LexiconEntry[]) => {
    const masterEntries = entries;
    let newEntries = 0;
    let conflicts = 0;
    let autoMerged = 0;
    let identicalSkipped = 0;
    const potentialIssues: Array<{
      type: 'conflict' | 'duplicate' | 'error';
      message: string;
      entry?: LexiconEntry;
    }> = [];

    mergeEntries.forEach((mergeEntry, mergeIndex) => {
      const mergeGraphemes = mergeEntry.graphemes.map(g => g.toLowerCase());
      
      // Find matching entries in master by grapheme (case-insensitive)
      const matchingMasterEntries = masterEntries.filter(masterEntry => 
        masterEntry.graphemes.some(masterGrapheme => 
          mergeGraphemes.includes(masterGrapheme.toLowerCase())
        )
      );
      
      if (matchingMasterEntries.length > 0) {
        matchingMasterEntries.forEach(masterEntry => {
          // Check if entries are identical (exact match)
          if (areIdentical(masterEntry, mergeEntry)) {
            identicalSkipped++;
            return;
          }
          
          // Check if entries are phonetically identical (different case but same phoneme)
          if (arePhoneticallyIdentical(masterEntry, mergeEntry)) {
            conflicts++;
            potentialIssues.push({
              type: 'conflict',
              message: `Case difference: "${mergeEntry.graphemes.join(', ')}" vs existing "${masterEntry.graphemes.join(', ')}" (same phoneme)`,
              entry: mergeEntry
            });
            return;
          }
          
          // Check if it's just additional aliases (case-insensitive comparison)
          const isAdditionalAlias = 
            masterEntry.phoneme === mergeEntry.phoneme &&
            masterEntry.alias?.toLowerCase() !== mergeEntry.alias?.toLowerCase();
          
          conflicts++;
          potentialIssues.push({
            type: 'conflict',
            message: `Conflict: "${mergeEntry.graphemes.join(', ')}" vs existing "${masterEntry.graphemes.join(', ')}" (${isAdditionalAlias ? 'different aliases' : 'different phonemes'})`,
            entry: mergeEntry
          });
        });
      } else {
        newEntries++;
      }
    });

    // Add error-related issues
    if (mergeDetailedErrors.length > 0) {
      potentialIssues.push({
        type: 'error',
        message: `🚫 BLOCKING: ${mergeDetailedErrors.length} entries have errors - merge cannot proceed until fixed`
      });
    }

    setMergePreview({
      newEntries,
      conflicts,
      autoMerged,
      identicalSkipped,
      errors: mergeDetailedErrors.length,
      potentialIssues
    });
  };

  const analyzeConflicts = (mergeEntries: LexiconEntry[]) => {
    const conflicts: MergeConflict[] = [];
    const masterEntries = entries;
    let autoMergedCount = 0;
    
    mergeEntries.forEach((mergeEntry, mergeIndex) => {
      const mergeGraphemes = mergeEntry.graphemes.map(g => g.toLowerCase());
      
      // Find matching entries in master by grapheme (case-insensitive)
      const matchingMasterEntries = masterEntries.filter(masterEntry => 
        masterEntry.graphemes.some(masterGrapheme => 
          mergeGraphemes.includes(masterGrapheme.toLowerCase())
        )
      );
      
      if (matchingMasterEntries.length > 0) {
        matchingMasterEntries.forEach(masterEntry => {
          const masterIndex = masterEntries.indexOf(masterEntry);
          
          // Check if entries are identical (exact match)
          if (areIdentical(masterEntry, mergeEntry)) {
            // Skip identical entries - they will be handled in performMerge
            return;
          }
          
          // Check if entries are phonetically identical (different case but same phoneme)
          if (arePhoneticallyIdentical(masterEntry, mergeEntry)) {
            // Show as a conflict for user decision instead of auto-merging
            conflicts.push({
              type: 'additional_alias', // Treat as additional alias since it's just case differences
              masterEntry,
              mergeEntry,
              masterIndex,
              mergeIndex,
              commonGraphemes: masterEntry.graphemes.filter(mg => 
                mergeGraphemes.includes(mg.toLowerCase())
              ),
              resolution: null // Will be set by user
            });
            return;
          }
          
          // Check if it's just additional aliases (case-insensitive comparison)
            const isAdditionalAlias = 
              masterEntry.phoneme === mergeEntry.phoneme &&
            masterEntry.alias?.toLowerCase() !== mergeEntry.alias?.toLowerCase();
            
            conflicts.push({
              type: isAdditionalAlias ? 'additional_alias' : 'conflict',
              masterEntry,
              mergeEntry,
              masterIndex,
              mergeIndex,
              commonGraphemes: masterEntry.graphemes.filter(mg => 
                mergeGraphemes.includes(mg.toLowerCase())
              ),
              resolution: null // Will be set by user
            });
        });
      }
    });
    
    setMergeConflicts(conflicts);
    
    if (conflicts.length > 0) {
      setShowConflictResolution(true);
      setShowMergeModal(false);
    } else {
      // No conflicts, proceed with merge
      performMerge(mergeEntries);
    }
  };

  const handleConflictResolution = (conflictIndex: number, resolution: 'master' | 'merge' | 'both') => {
    const updatedConflicts = [...mergeConflicts];
    updatedConflicts[conflictIndex].resolution = resolution;
    setMergeConflicts(updatedConflicts);
  };

  // Bulk merge functions
  const resolveAllConflicts = (resolution: 'master' | 'merge' | 'both') => {
    const updatedConflicts = mergeConflicts.map(conflict => ({
      ...conflict,
      resolution
    }));
    setMergeConflicts(updatedConflicts);
  };

  const resolveAllAdditionalAliases = (resolution: 'master' | 'merge' | 'both') => {
    const updatedConflicts = mergeConflicts.map(conflict => ({
      ...conflict,
      resolution: conflict.type === 'additional_alias' ? resolution : conflict.resolution
    }));
    setMergeConflicts(updatedConflicts);
  };

  const resolveAllConflictsOnly = (resolution: 'master' | 'merge' | 'both') => {
    const updatedConflicts = mergeConflicts.map(conflict => ({
      ...conflict,
      resolution: conflict.type === 'conflict' ? resolution : conflict.resolution
    }));
    setMergeConflicts(updatedConflicts);
  };

  const finalizeMerge = () => {
    const resolvedEntries = [...entries];
    let conflictsResolved = 0;
    
    mergeConflicts.forEach(conflict => {
      const { masterEntry, mergeEntry, masterIndex, resolution } = conflict;
      
      if (resolution === 'merge') {
        // Replace master entry with merge entry
        resolvedEntries[masterIndex] = { ...mergeEntry, isNew: true };
        conflictsResolved++;
      } else if (resolution === 'both') {
        // Combine both entries (case-insensitive grapheme deduplication)
        const masterGraphemesLower = masterEntry.graphemes.map(g => g.toLowerCase());
        const uniqueMergeGraphemes = mergeEntry.graphemes.filter(g => 
          !masterGraphemesLower.includes(g.toLowerCase())
        );
        const combinedGraphemes = [...masterEntry.graphemes, ...uniqueMergeGraphemes];
        
        resolvedEntries[masterIndex] = {
          graphemes: combinedGraphemes,
          alias: mergeEntry.alias || masterEntry.alias,
          phoneme: mergeEntry.phoneme || masterEntry.phoneme,
          isNew: true
        };
        conflictsResolved++;
      } else if (resolution === 'master') {
        conflictsResolved++;
      }
      // If resolution is 'master', keep the original entry
    });
    
    // Count new entries added
    let newEntriesAdded = 0;
    
    // Add new entries that don't conflict
    mergeFileContent.forEach(mergeEntry => {
      const mergeGraphemes = mergeEntry.graphemes.map(g => g.toLowerCase());
      const hasConflict = mergeConflicts.some(conflict => 
        conflict.mergeEntry.graphemes.some((mg: string) => 
          mergeGraphemes.includes(mg.toLowerCase())
        )
      );
      
      if (!hasConflict) {
        const hasMatchInMaster = entries.some(masterEntry => 
          masterEntry.graphemes.some(mg => mergeGraphemes.includes(mg.toLowerCase()))
        );
        
        if (!hasMatchInMaster) {
          resolvedEntries.push({ ...mergeEntry, isNew: true });
          newEntriesAdded++;
        }
      }
    });
    
    // Calculate identical entries skipped
    const identicalSkipped = mergeFileContent.length - mergeConflicts.length - newEntriesAdded;
    
    // Sort alphabetically
    resolvedEntries.sort((a, b) => {
      const aGrapheme = a.graphemes[0]?.toLowerCase() || '';
      const bGrapheme = b.graphemes[0]?.toLowerCase() || '';
      return aGrapheme.localeCompare(bGrapheme);
    });
    
    // Set merge summary
    setMergeSummary({
      newEntries: newEntriesAdded,
      conflictsResolved: conflictsResolved, 
      identicalSkipped: identicalSkipped,   
      totalProcessed: mergeFileContent.length,
      errorsFound: 0
    });
    
    setEntries(resolvedEntries);
    setShowConflictResolution(false);
    setMergeFile(null);
    setMergeFileContent([]);
    setMergeConflicts([]);
    
    // Show detailed success message
    setToast({ 
      type: 'success', 
      message: `Merge completed: ${newEntriesAdded} new entries, ${conflictsResolved} conflicts resolved, ${identicalSkipped} identical entries skipped` 
    });
  };

  const performMerge = (mergeEntries: LexiconEntry[]) => {
    const masterEntries = [...entries];
    let newEntriesAdded = 0;
    let identicalSkipped = 0;
    
    // Add new entries that don't exist in master
    mergeEntries.forEach(mergeEntry => {
      const mergeGraphemes = mergeEntry.graphemes.map(g => g.toLowerCase());
      const hasMatchInMaster = masterEntries.some(masterEntry => 
        masterEntry.graphemes.some(mg => mergeGraphemes.includes(mg.toLowerCase()))
      );
      
      if (!hasMatchInMaster) {
        masterEntries.push({ ...mergeEntry, isNew: true });
        newEntriesAdded++;
      } else {
        // Check if it's identical
        const matchingEntry = masterEntries.find(masterEntry => 
          masterEntry.graphemes.some(mg => mergeGraphemes.includes(mg.toLowerCase()))
        );
        if (matchingEntry) {
          const isIdentical = areIdentical(matchingEntry, mergeEntry);
          if (isIdentical) {
            identicalSkipped++;
          }
        }
      }
    });
    
    // Sort alphabetically
    masterEntries.sort((a, b) => {
      const aGrapheme = a.graphemes[0]?.toLowerCase() || '';
      const bGrapheme = b.graphemes[0]?.toLowerCase() || '';
      return aGrapheme.localeCompare(bGrapheme);
    });
    
    // Set merge summary
    setMergeSummary({
      newEntries: newEntriesAdded,
      conflictsResolved: 0,
      identicalSkipped: identicalSkipped,
      totalProcessed: mergeEntries.length,
      errorsFound: mergeDetailedErrors.length
    });
    
    setEntries(masterEntries);
    setShowMergeModal(false);
    setMergeFile(null);
    setMergeFileContent([]);
    setMergeConflicts([]);
    
    // Show detailed success message
    const errorMessage = mergeDetailedErrors.length > 0 ? `, ${mergeDetailedErrors.length} entries skipped due to errors` : '';
    setToast({ 
      type: 'success', 
      message: `Merge completed: ${newEntriesAdded} new entries, 0 conflicts, ${identicalSkipped} identical entries skipped${errorMessage}` 
    });
  };

  // Publish to Web-TTS handlers
  const handlePublishToWebTTS = async () => {
    if (!currentFile) {
      setToast({ type: 'error', message: 'No lexicon file selected' });
      return;
    }

    setPublishLoading(true);
    setPublishError(null);

    try {
      // First, ensure the lexicon is saved
      if (hasUnsavedChanges) {
        await handleSaveLexicon();
      }

      // Generate the lexicon URL
      const lexiconUrl = `https://skillsoftlexicons.blob.core.windows.net/lexicons/${currentFile}`;
      
      // Add to settings.xml
      await addLexiconToSettings(newLexiconLang, currentFile, lexiconUrl);
      
      setShowPublishModal(false);
      setToast({ 
        type: 'success', 
        message: `Lexicon "${currentFile}" has been published to TTS tool` 
      });
      
      // Refresh settings data and lexicon list
      await loadSettingsData();
      await refreshLexiconList();
    } catch (error: any) {
      console.error('Error publishing to Web-TTS:', error);
      setPublishError(error.message);
    } finally {
      setPublishLoading(false);
    }
  };

  const handleRemoveFromWebTTS = async () => {
    if (!currentFile) {
      setRemoveError('No lexicon file selected');
      return;
    }

    setRemoveLoading(true);
    setRemoveError(null);

    try {
      // Find the lexicon URL for the current file
              const currentLexiconUrl = `https://skillsoftlexicons.blob.core.windows.net/lexicons/${currentFile}`;
      await removeLexiconFromSettings(newLexiconLang, currentLexiconUrl);
      
      setShowRemoveModal(false);
      setToast({ 
        type: 'success', 
        message: `Lexicon "${currentFile}" has been removed from TTS tool` 
      });
      
      // Clear the current lexicon from UI state since it's no longer published
      setSettingsLexicons(prev => {
        const updated = { ...prev };
        if (updated[newLexiconLang]) {
          updated[newLexiconLang] = updated[newLexiconLang].filter(
            lex => !lex.url.endsWith(currentFile)
          );
        }
        return updated;
      });
      
      // Refresh lexicon list to ensure it's up to date
      await refreshLexiconList();
    } catch (error: any) {
      console.error('Error removing from Web-TTS:', error);
      setRemoveError(error.message);
    } finally {
      setRemoveLoading(false);
    }
  };

  const handleDeleteLexicon = async (lexiconName: string) => {
    setDeletingLexicon(lexiconName);
    try {
      // Only pass API key in suite mode; backend uses env vars otherwise
      const apiKey = isSuiteMode ? getLexiconApiKey() : null;
      await deleteLexicon(lexiconName, apiKey);
      
      // Remove from blob list
      setBlobList(prev => prev.filter(name => name !== lexiconName));
      
      // If this was the currently open lexicon, clear it
      if (currentFile === lexiconName) {
        setCurrentFile('');
        setEntries([]);
        setSavedEntries([]);
        setValidationErrors({});
        setPhonemeInputWarning(null);
      }
      
      setToast({ type: 'success', message: 'Lexicon deleted successfully' });
      setShowDeleteModal(false);
      setLexiconToDelete(null);
      
    } catch (error: any) {
      console.error('Error deleting lexicon:', error);
      setToast({ type: 'error', message: error.message || 'Failed to delete lexicon' });
    } finally {
      setDeletingLexicon(null);
    }
  };

  const handleDeleteClick = (lexiconName: string) => {
    setLexiconToDelete(lexiconName);
    setShowDeleteModal(true);
  };

  const isLexiconPublished = (lexiconName: string): boolean => {
    // Check if lexicon is published by looking in settingsLexicons
    for (const languageId in settingsLexicons) {
      if (settingsLexicons[languageId].some(lex => lex.url.endsWith(lexiconName))) {
        return true;
      }
    }
    return false;
  };

  const loadSettingsData = async () => {
    setLoadingSettings(true);
    try {
      const settingsXml = await loadSettingsLexicons();
      
      // Try to parse the settings XML, but handle malformed XML gracefully
      let lexiconsByLanguage: {[languageId: string]: Array<{name: string, url: string}>} = {};
      
      try {
        const parser = new XMLParser({ 
          ignoreAttributes: false,
          attributeNamePrefix: "@_",
          textNodeName: "#text"
        });
        
        const settings = parser.parse(settingsXml);
        
        if (settings.settings && settings.settings.languages && settings.settings.languages.language) {
          const languages = Array.isArray(settings.settings.languages.language) 
            ? settings.settings.languages.language 
            : [settings.settings.languages.language];
          
          languages.forEach((lang: any) => {
            const languageId = lang['@_id'];
            if (lang.lexicons && lang.lexicons.lexicon) {
              const lexicons = Array.isArray(lang.lexicons.lexicon) 
                ? lang.lexicons.lexicon 
                : [lang.lexicons.lexicon];
              
              lexiconsByLanguage[languageId] = lexicons.map((lex: any) => ({
                name: lex['@_name'],
                url: lex['@_id']
              }));
            }
          });
        }
      } catch (parseError) {
        console.warn('XML parsing failed, falling back to regex parsing:', parseError);
        
        // Fallback: Use regex to extract lexicon information from malformed XML
        const languageMatches = settingsXml.match(/<language[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/language>/g);
        
        if (languageMatches) {
          languageMatches.forEach(languageMatch => {
            const languageIdMatch = languageMatch.match(/id="([^"]*)"/);
            const languageId = languageIdMatch ? languageIdMatch[1] : null;
            
            if (languageId) {
              const lexiconMatches = languageMatch.match(/<lexicon[^>]*name="([^"]*)"[^>]*id="([^"]*)"[^>]*\/?>/g);
              if (lexiconMatches) {
                lexiconsByLanguage[languageId] = lexiconMatches.map(lexiconMatch => {
                  const nameMatch = lexiconMatch.match(/name="([^"]*)"/);
                  const urlMatch = lexiconMatch.match(/id="([^"]*)"/);
                  return {
                    name: nameMatch ? nameMatch[1] : '',
                    url: urlMatch ? urlMatch[1] : ''
                  };
                });
              }
            }
          });
        }
      }
      
      setSettingsLexicons(lexiconsByLanguage);
    } catch (error: any) {
      // Only log errors that aren't expected (like missing API key)
      if (error.message !== 'API key not set') {
        console.error('Error loading settings data:', error);
      }
      // Don't show error toast for settings loading as it's not critical
    } finally {
      setLoadingSettings(false);
    }
  };

  // Load settings data when component mounts and authenticated
  useEffect(() => {
    // Don't make API calls until authenticated
    if (!isAuthenticated) {
      return;
    }
    loadSettingsData();
  }, [isAuthenticated]);


  // In suite mode, load blobs when lexicon key is received
  useEffect(() => {
    if (isSuiteMode && suiteLexiconKey && !loadingBlobs) {
      const loadBlobs = async () => {
        try {
          setLoadingBlobs(true);
          const blobs = await listBlobsFromBackend();
          setBlobList(blobs);
          setError(null);
          setBlobErrorDetail(null);
        } catch (e: any) {
          console.error('Error loading blobs in suite mode:', e);
          setError('Failed to load lexicon list. Please try again.');
          setBlobErrorDetail(e.message);
        } finally {
          setLoadingBlobs(false);
        }
      };
      loadBlobs();
    }
  }, [isSuiteMode, suiteLexiconKey]);

  // Reload settings data when currentFile changes to ensure accurate publish status
  useEffect(() => {
    if (currentFile) {
      loadSettingsData();
    }
  }, [currentFile]);

  return (
    <ProtectedRoute>
      <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100">
        <div className={`max-w-[900px] mx-auto bg-white rounded-xl shadow-2xl border border-gray-100 overflow-hidden flex flex-col h-[664px] mt-8`}>
        {/* Header Section */}
        <div className="relative h-[120px] flex items-center justify-between px-6" style={{height: '120px', paddingLeft: '24px', paddingRight: '24px'}}>
          <div className="flex items-center h-full">
            <img
              src={process.env.PUBLIC_URL + '/images/4.jpg'}
              alt="Skillsoft Lexicon Editor header"
              className="absolute inset-0 w-full h-full object-cover rounded-t-xl"
              style={{height: '120px', width: '100%', objectFit: 'cover', transform: 'scaleX(-1)'}}
              draggable="false"
            />
            <div className="absolute inset-0 rounded-t-xl" style={{background: 'linear-gradient(to right, rgba(17,24,39,0.85) 0%, rgba(17,24,39,0.0) 100%)'}} />
            <div className="relative h-full flex items-center">
              <div className="text-white">
                <h1 style={{fontSize: '30px', fontWeight: 700, color: 'white', margin: 0, lineHeight: 1.1}}>Lexicon Editor</h1>
                <p style={{fontSize: '14px', color: '#e5e7eb', marginTop: 4, marginBottom: 0, lineHeight: 1.2}}>Edit and manage your lexicon entries</p>
              </div>
            </div>
          </div>
        </div>

        {/* Toolbar Ribbon */}
        <div className="flex flex-col w-full px-0 py-0.5 border-b border-gray-200 bg-white sticky top-0 z-10">
          {/* Button Row + File Info Row */}
          <div className="flex items-center w-full">
            {/* Left group: Open, Import, New (work without lexicon) */}
            <div className="flex items-center gap-4 ml-6">
              <div className="flex flex-col items-center">
                <button
                  onClick={handleOpenLexicon}
                  className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                  style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                  aria-label="Open lexicon"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h3.172a2 2 0 011.414.586l1.828 1.828A2 2 0 0012.828 8H19a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                </button>
                <span className="w-10 text-[10px] leading-tight text-center mt-0.5 mb-1 text-gray-600">Open</span>
              </div>
              <div className="flex flex-col items-center">
                <button
                  onClick={handleImportClick}
                  className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                  style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                  aria-label="Import lexicon"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                  </svg>
                </button>
                <span className="w-10 text-[10px] leading-tight text-center mt-0.5 mb-1 text-gray-600">Import</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  id="import-lexicon-file"
                  name="import-lexicon-file"
                  accept=".xml,.tsv,.txt,.csv"
                  style={{ display: 'none' }}
                  onChange={handleImportFileChange}
                  aria-label="Import lexicon file"
                />
              </div>
              <div className="flex flex-col items-center">
                <button
                  onClick={() => setShowNewLexiconModal(true)}
                  className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                  style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                  aria-label="Create new lexicon"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                </button>
                <span className="w-10 text-[10px] leading-tight text-center mt-0.5 mb-1 text-gray-600">New</span>
              </div>
              <div className="flex flex-col items-center">
                <button
                  onClick={() => currentFile && handleDeleteClick(currentFile)}
                  disabled={!currentFile || isLexiconPublished(currentFile)}
                  className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                  aria-label="Delete lexicon"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
                <span className="w-10 text-[10px] leading-tight text-center mt-0.5 mb-1 text-gray-600">Delete</span>
              </div>
              <div className="flex flex-col items-center">
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log('Save button clicked', { hasUnsavedChanges, currentFile, disabled: !hasUnsavedChanges });
                    if (hasUnsavedChanges) {
                      handleSaveLexicon();
                    } else {
                      console.warn('Save button clicked but disabled - no unsaved changes');
                    }
                  }}
                  disabled={!hasUnsavedChanges}
                  className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                  aria-label="Save lexicon"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                  </svg>
                </button>
                <span className="w-10 text-[10px] leading-tight text-center mt-0.5 mb-1 text-gray-600">Save</span>
              </div>
              <div className="flex flex-col items-center">
                <button
                  onClick={handleExportLexicon}
                  disabled={!currentFile}
                  className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                  aria-label="Export lexicon"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
                <span className="w-10 text-[10px] leading-tight text-center mt-0.5 mb-1 text-gray-600">Export</span>
              </div>
              <div className="flex flex-col items-center">
                <button
                  onClick={handleMergeClick}
                  disabled={!currentFile}
                  className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                  aria-label="Merge lexicon"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16l2.879-2.879a3 3 0 014.242 0L18 16M8 8l2.879 2.879a3 3 0 004.242 0L18 8" />
                  </svg>
                </button>
                <span className="w-10 text-[10px] leading-tight text-center mt-0.5 mb-1 text-gray-600">Merge</span>
              </div>
              <div className="flex flex-col items-center">
                <button
                  onClick={handleDuplicateLexicon}
                  disabled={!currentFile}
                  className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                  aria-label="Duplicate lexicon"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke="currentColor" strokeWidth="2" fill="none" /><rect x="3" y="3" width="13" height="13" rx="2" ry="2" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
                </button>
                <span className="w-10 text-[10px] leading-tight text-center mt-0.5 mb-1 text-gray-600">Duplicate</span>
              </div>
              <div className="flex flex-col items-center">
                <div className="flex items-center gap-1">
                  {!currentFile ? (
                    // No file open - disabled state
                    <button
                      disabled={true}
                      className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 focus:ring-2 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed text-gray-400 bg-gray-100"
                      style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                      aria-label="Publish to TTS"
                      title="No lexicon open to publish"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                      </svg>
                    </button>
                  ) : settingsLexicons[newLexiconLang] && settingsLexicons[newLexiconLang].some(lex => lex.url.endsWith(currentFile)) ? (
                    // File is published - show remove button
                    <button
                      onClick={() => setShowRemoveModal(true)}
                      className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 focus:ring-2 focus:outline-none text-red-600 hover:bg-red-100 focus:ring-red-500"
                      style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                      aria-label="Remove from TTS"
                      title="Remove lexicon from TTS application"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  ) : (
                    // File is not published - show publish button
                    <button
                      onClick={() => {
                        if (hasUnsavedChanges) {
                          if (window.confirm('You have unsaved changes. Would you like to save the lexicon before publishing to the TTS tool?')) {
                            handleSaveLexicon().then(() => {
                              setShowPublishModal(true);
                            });
                          }
                        } else {
                          setShowPublishModal(true);
                        }
                      }}
                      className="w-9 h-9 flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 focus:ring-2 focus:outline-none text-gray-700 hover:bg-gray-100 focus:ring-gray-500"
                      style={{ minWidth: '36px', minHeight: '36px', maxWidth: '36px', maxHeight: '36px' }}
                      aria-label="Publish to TTS"
                      title="Publish lexicon to TTS application"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                      </svg>
                    </button>
                  )}
                </div>
                <span className="w-12 text-[10px] leading-tight text-center mt-0.5 mb-1 text-gray-600">
                  {!currentFile 
                    ? 'TTS' 
                    : settingsLexicons[newLexiconLang] && settingsLexicons[newLexiconLang].some(lex => lex.url.endsWith(currentFile))
                      ? 'Remove' 
                      : 'Publish'
                  }
                </span>
              </div>
            </div>
            {/* Divider aligned with main content split */}
            {currentFile && (
              <div className="flex items-center ml-auto mr-6 h-full">
                <span className="text-xs text-gray-700 font-mono flex items-center h-11" style={{fontSize: '1rem', height: '44px', lineHeight: '44px', padding: 0}}>
                </span>
              </div>
            )}

          </div>
        </div>


        {/* Language Banner */}
        {currentFile && (
          <div className="w-full bg-gradient-to-r from-red-400 to-red-500 py-1.5 px-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSaveAsClick}
                  className="text-white hover:text-gray-200 transition-colors"
                  title="Rename lexicon"
                  aria-label="Rename lexicon"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                <span className="text-white font-mono text-sm">
                  {currentFile}
                </span>
                <span className="text-white font-mono text-sm">|</span>
                <span className="text-white font-mono text-sm">
                  {findLanguageById(newLexiconLang)?.name || newLexiconLang}
                </span>
              </div>
              
              {/* Save Status Info */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1">
                  {hasUnsavedChanges ? (
                    <span className="text-white text-xs opacity-75 italic">
                      Unsaved changes*
                    </span>
                  ) : (
                    <span className="text-white text-xs opacity-75">
                      Saved
                    </span>
                  )}
                  <span className="text-white text-xs opacity-50">|</span>
                  {(() => {
                    const isPublished = settingsLexicons[newLexiconLang] && settingsLexicons[newLexiconLang].some(lex => lex.url.endsWith(currentFile));
                    return isPublished;
                  })() ? (
                    <span className="text-white text-xs opacity-75">
                      Published
                    </span>
                  ) : (
                    <span className="text-white text-xs opacity-75 italic">
                      Not published*
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="px-6 py-3 space-y-4 flex-1 flex flex-col min-h-0">
          {currentFile ? (
            <div className="md:grid md:grid-cols-2 gap-4 mt-1 flex-1 min-h-0">
              <aside className="flex flex-col h-full min-h-0">
                <div className="flex flex-col h-full rounded-lg bg-gray-50 border border-gray-200 min-h-[220px] p-0 relative" style={{maxHeight: 'none'}}>
                  {/* Show content only when a lexicon is open */}
                  <>
                    {/* Controls: Add, Delete, Search - fixed at top */}
                    <div className="mb-2 flex justify-end items-center p-4" style={{minHeight: '56px'}}>
                      <div className="flex gap-2">
                        <button
                          onClick={handleNewEntry}
                          disabled={!currentFile}
                          className="flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none border border-gray-300 disabled:opacity-70 disabled:cursor-not-allowed"
                          style={unifiedButtonStyle}
                          aria-label="Add new entry"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                        </button>
                        <button
                          onClick={handleDeleteEntry}
                          disabled={!currentFile || selectedIndex === null}
                          className="flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 bg-red-200 text-red-700 hover:bg-red-300 focus:ring-2 focus:ring-red-500 focus:outline-none border border-red-200 disabled:opacity-70 disabled:cursor-not-allowed"
                          style={unifiedButtonStyle}
                          aria-label="Delete selected entry"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22" /></svg>
                        </button>
                      </div>
                      <div className="ml-auto flex items-center" style={{transition: 'width 0.2s'}}>
                        <div className="flex items-center" style={{height: '36px'}}>
                          <div className="flex items-center bg-gray-200 rounded-lg px-2 mr-2" style={{height: '36px', maxWidth: 260, transition: 'max-width 0.2s'}}>
                            {searchQuery && (
                              <button
                                onClick={() => setSearchQuery('')}
                                className="mr-1 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-700 focus:outline-none"
                                style={{width: '32px', height: '32px'}}
                                tabIndex={-1}
                                aria-label="Clear search"
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            )}
                            <input
                              type="text"
                              id="search-entries"
                              name="search-entries"
                              value={searchQuery}
                              onChange={e => setSearchQuery(e.target.value)}
                              placeholder="Search..."
                              className="bg-transparent outline-none border-none text-gray-900 flex-1 px-1 min-w-0"
                              style={{fontSize: '15px', height: '32px'}}
                              aria-label="Search entries"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                    {/* Entry list - scrollable */}
                    <div className="flex-1 overflow-y-auto" style={{minHeight: 0}}>
                      {filteredEntries.length === 0 ? (
                        <div style={{position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none'}}>
                          <span className="text-gray-400 text-sm text-center">No entries</span>
                        </div>
                      ) : (
                        <div role="list" aria-label="Lexicon entries" ref={entriesListRef}>
                          {filteredEntries.map(({ entry, originalIndex }) => {
                            const isSelected = selectedIndex === originalIndex;
                            return (
                              <div
                                key={originalIndex}
                                data-index={originalIndex}
                                onClick={() => setSelectedIndex(originalIndex)}
                                className={`cursor-pointer text-base transition-all duration-200 border-y mb-0 last:mb-0 px-4 py-2 ${isSelected ? 'border-gray-700' : 'hover:bg-gray-100 border-gray-200'}`}
                                style={{
                                  ...entryBoxStyle,
                                  ...(isSelected
                                    ? { background: '#374151', color: 'white', border: '#374151 1px solid' }
                                    : { background: 'white', color: '#1f2937', border: '#e5e7eb 1px solid' })
                                }}
                                role="listitem"
                                aria-selected={isSelected}
                              >
                                <span className="flex items-center gap-1">
                                  {entry.graphemes[0]}
                                  {entry.isNew && <span className="text-orange-500 font-bold">*</span>}
                                  {validationErrors[originalIndex] && (
                                    <span className="text-red-500 font-bold" title="Validation errors">⚠</span>
                                  )}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                </div>
              </aside>

              <main className="flex flex-col h-full min-h-0">
                <div className="bg-gray-50 rounded-lg p-4 shadow-inner flex-1 flex flex-col min-h-[220px] overflow-y-auto">
                  {currentFile ? (
                    selectedIndex !== null ? (
                      <div className="space-y-4">
                        {/* Validation Errors Display */}
                        {validationErrors[selectedIndex] && validationErrors[selectedIndex].length > 0 && (
                          <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-red-500 font-bold">⚠</span>
                              <span className="text-red-700 font-medium text-sm">Validation Errors:</span>
                            </div>
                            <ul className="text-red-600 text-sm space-y-1">
                              {validationErrors[selectedIndex].map((error, idx) => (
                                <li key={idx} className="flex items-start gap-1">
                                  <span className="text-red-400 mt-1">•</span>
                                  <span>{error}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        <div className="form-group">
                          <label className="form-label group relative inline-flex items-center gap-1">
                            Graphemes
                            {activeTooltip === 'graphemes' && (
                              <div 
                                className="absolute left-0 -bottom-2 translate-y-[100%] bg-gray-800 text-white text-sm rounded-lg px-3 py-2 w-64 shadow-lg z-10"
                                onClick={(e) => e.stopPropagation()}
                                role="tooltip"
                                aria-label="Graphemes help"
                              >
                                <div className="flex justify-between items-start gap-2">
                                  <span>The written form of a word or phrase. For example, "hello" is a grapheme.</span>
                                  <button 
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setActiveTooltip(null);
                                    }}
                                    className="text-gray-400 hover:text-white transition-colors"
                                    aria-label="Close tooltip"
                                  >
                                    ×
                                  </button>
                                </div>
                              </div>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setActiveTooltip(activeTooltip === 'graphemes' ? null : 'graphemes');
                              }}
                              className="text-gray-400 hover:text-gray-600 transition-colors flex items-center"
                              aria-label="Show graphemes help"
                              aria-expanded={activeTooltip === 'graphemes'}
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </button>
                          </label>
                          <div style={{marginBottom: '0.5rem'}} />
                          <div role="list" aria-label="Grapheme entries">
                            {entries[selectedIndex].graphemes.map((grapheme, gIdx) => (
                              <div key={gIdx} className="flex gap-2 mb-2 items-center" style={{ alignItems: 'center', height: '36px' }} role="listitem">
                                <input
                                  type="text"
                                  id={`grapheme-${selectedIndex}-${gIdx}`}
                                  name={`grapheme-${selectedIndex}-${gIdx}`}
                                  value={grapheme}
                                  onChange={(e) => handleGraphemeChange(gIdx, e.target.value)}
                                  className="input flex-grow"
                                  style={unifiedInputStyle}
                                  aria-label={`Grapheme ${gIdx + 1}`}
                                />
                                <div style={{ width: '36px', flexShrink: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', height: '36px' }}>
                                  {gIdx > 0 && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleRemoveGrapheme(gIdx);
                                      }}
                                      className="flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 bg-red-200 text-red-700 hover:bg-red-300 focus:ring-2 focus:ring-red-500 focus:outline-none border border-red-200"
                                      style={unifiedButtonStyle}
                                      aria-label={`Remove grapheme ${gIdx + 1}`}
                                    >
                                      ×
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                          <button
                            onClick={handleAddGrapheme}
                            className="flex items-center justify-center text-base rounded-lg font-medium transition-all duration-200 text-gray-700 hover:bg-gray-100 focus:ring-2 focus:ring-gray-500 focus:outline-none border border-gray-300 mt-2"
                            style={unifiedButtonStyle}
                            aria-label="Add grapheme"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                          </button>
                        </div>
                        <div className="form-group">
                          <div className="mb-1">
                            <label className="form-label group relative inline-flex items-center gap-1">
                              Alias
                              {activeTooltip === 'alias' && (
                                <div 
                                  className="absolute left-0 -bottom-2 translate-y-[100%] bg-gray-800 text-white text-sm rounded-lg px-3 py-2 w-64 shadow-lg z-10"
                                  onClick={(e) => e.stopPropagation()}
                                  role="tooltip"
                                  aria-label="Alias help"
                                >
                                  <div className="flex justify-between items-start gap-2">
                                    <span>A shorter or alternative form of the word. For example, "USA" could be an alias for "United States of America", or "Dr." for "Doctor".</span>
                                    <button 
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveTooltip(null);
                                      }}
                                      className="text-gray-400 hover:text-white transition-colors"
                                      aria-label="Close tooltip"
                                    >
                                      ×
                                    </button>
                                  </div>
                                </div>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveTooltip(activeTooltip === 'alias' ? null : 'alias');
                                }}
                                className="text-gray-400 hover:text-gray-600 transition-colors"
                                aria-label="Show alias help"
                                aria-expanded={activeTooltip === 'alias'}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                              </button>
                            </label>
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              id={`alias-${selectedIndex}`}
                              name={`alias-${selectedIndex}`}
                              value={entries[selectedIndex].alias || ''}
                              onChange={(e) => handleAliasChange(e.target.value)}
                              className="input"
                              style={unifiedInputStyle}
                              aria-label="Alias"
                            />
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <span className="text-xs text-gray-500">Say As:</span>
                              <select
                                id={`alias-say-as-${selectedIndex}`}
                                name={`alias-say-as-${selectedIndex}`}
                                value={entries[selectedIndex].aliasSayAsType || ''}
                                onChange={(e) => handleAliasSayAsChange(e.target.value)}
                                disabled={!entries[selectedIndex].alias || entries[selectedIndex].alias?.trim() === ''}
                                className={`text-xs px-1 py-0.5 border rounded ${
                                  !entries[selectedIndex].alias || entries[selectedIndex].alias?.trim() === ''
                                    ? 'border-gray-200 bg-gray-100 text-gray-400'
                                    : 'border-gray-300 bg-white'
                                }`}
                                style={{ width: '140px', fontSize: '0.75rem' }}
                                aria-label="Alias Say As"
                              >
                                {SAY_AS_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        </div>
                        <div className="form-group">
                          <div className="mb-1">
                            <label className="form-label group relative inline-flex items-center gap-1">
                              Phoneme (IPA)
                              {activeTooltip === 'phoneme' && (
                                <div 
                                  className="absolute left-0 -bottom-2 translate-y-[100%] bg-gray-800 text-white text-sm rounded-lg px-3 py-2 w-72 shadow-lg z-10"
                                  onClick={(e) => e.stopPropagation()}
                                  role="tooltip"
                                  aria-label="Phoneme help"
                                >
                                  <div className="flex justify-between items-start gap-2">
                                    <div>
                                      <div className="mb-2">The pronunciation using IPA symbols. Examples:</div>
                                      <div className="text-xs space-y-1 mb-2">
                                        <div>• "hello" → həˈloʊ</div>
                                        <div>• "cat" → kæt</div>
                                        <div>• "night" → naɪt</div>
                                      </div>
                                      <div className="text-xs text-gray-300">Only valid IPA characters are allowed. Invalid characters will be automatically removed.</div>
                                    </div>
                                    <button 
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveTooltip(null);
                                      }}
                                      className="text-gray-400 hover:text-white transition-colors"
                                      aria-label="Close tooltip"
                                    >
                                      ×
                                    </button>
                                  </div>
                                </div>
                              )}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveTooltip(activeTooltip === 'phoneme' ? null : 'phoneme');
                                }}
                                className="text-gray-400 hover:text-gray-600 transition-colors"
                                aria-label="Show phoneme help"
                                aria-expanded={activeTooltip === 'phoneme'}
                              >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                              </button>
                            </label>
                          </div>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              id={`phoneme-${selectedIndex}`}
                              name={`phoneme-${selectedIndex}`}
                              value={entries[selectedIndex].phoneme || ''}
                              onChange={(e) => handlePhonemeChange(e.target.value)}
                              className="input"
                              style={unifiedInputStyle}
                              placeholder="Enter IPA phonemes (e.g., həˈloʊ)"
                              aria-label="Phoneme"
                            />
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <span className="text-xs text-gray-500">Say As:</span>
                              <select
                                id={`phoneme-say-as-${selectedIndex}`}
                                name={`phoneme-say-as-${selectedIndex}`}
                                value={entries[selectedIndex].phonemeSayAsType || ''}
                                onChange={(e) => handlePhonemeSayAsChange(e.target.value)}
                                disabled={!entries[selectedIndex].phoneme || entries[selectedIndex].phoneme?.trim() === ''}
                                className={`text-xs px-1 py-0.5 border rounded ${
                                  !entries[selectedIndex].phoneme || entries[selectedIndex].phoneme?.trim() === ''
                                    ? 'border-gray-200 bg-gray-100 text-gray-400'
                                    : 'border-gray-300 bg-white'
                                }`}
                                style={{ width: '140px', fontSize: '0.75rem' }}
                                aria-label="Phoneme Say As"
                              >
                                {SAY_AS_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          {phonemeInputWarning && (
                            <div className="mt-1 text-orange-600 text-xs flex items-center gap-1">
                              <span>⚠</span>
                              <span>{phonemeInputWarning}</span>
                            </div>
                          )}
                          <div className="mt-3">
                            <button
                              ref={setPreviewButtonRef}
                              onClick={handlePreview}
                              disabled={previewLoading || !entries[selectedIndex] || 
                                !entries[selectedIndex].graphemes || 
                                entries[selectedIndex].graphemes.length === 0 || 
                                entries[selectedIndex].graphemes[0] === '*** NEW ENTRY ***' ||
                                ((!entries[selectedIndex].phoneme || entries[selectedIndex].phoneme?.trim() === '') && 
                                 (!entries[selectedIndex].alias || entries[selectedIndex].alias?.trim() === ''))}
                              className="w-full px-3 py-2 bg-gray-700 hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors duration-200 flex items-center justify-center gap-2"
                              aria-label="Preview pronunciation"
                            >
                              {previewLoading ? (
                                <>
                                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" aria-hidden="true"></div>
                                  <span>Loading Preview...</span>
                                </>
                              ) : (
                                <>
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                  </svg>
                                  <span>Preview Pronunciation</span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm text-center" role="status">
                        Select an entry or create a new one to begin editing
                      </div>
                    )
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-gray-400 text-sm text-center" />
                  )}
                </div>
              </main>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm text-center">
              Open a lexicon to begin editing
            </div>
          )}
        </div>

        {/* File Selection Modal */}
        {showFileModal && (
          <>
            <div className="modal-backdrop" onClick={() => setShowFileModal(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="file-modal-title">
              <div className="modal-content">
                <div className="flex justify-between items-center mb-4">
                  <h2 id="file-modal-title" className="text-xl font-semibold">Select a Lexicon File</h2>
                  <button
                    onClick={() => setShowFileModal(false)}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close modal"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {loadingBlobs ? (
                  <div className="text-center py-4" role="status" aria-live="polite">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto" aria-hidden="true"></div>
                    <p className="mt-2 text-gray-600">Loading lexicons...</p>
                  </div>
                ) : error ? (
                  <div className="text-red-500 mb-4" role="alert">
                    {error}
                    {blobErrorDetail && (
                      <div className="text-sm mt-2">{blobErrorDetail}</div>
                    )}
                    <button
                      onClick={() => setRetryCount(0)}
                      className="mt-4 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-700"
                      aria-label="Retry loading lexicons"
                    >
                      Retry
                    </button>
                  </div>
                ) : blobList.length === 0 ? (
                  <div className="text-center py-4 text-gray-500" role="status">
                    <p>No lexicons found. Create a new one to get started.</p>
                  </div>
                ) : (
                  <div className="max-h-[400px] overflow-y-auto pr-2" role="listbox" aria-label="Available lexicons">
                    <div className="space-y-1">
                      {blobList.map((blob) => {
                        const isPublished = isLexiconPublished(blob);
                        return (
                          <div key={blob} className="flex items-center gap-2 group">
                            <button
                              onClick={() => handleSelectBlob(blob)}
                              className="flex-1 text-left py-1.5 px-2 rounded-lg hover:bg-gray-100 transition-colors text-sm truncate"
                              title={blob}
                              role="option"
                              aria-selected={currentFile === blob}
                            >
                              {blob}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!isPublished) {
                                  handleDeleteClick(blob);
                                }
                              }}
                              className={`opacity-0 group-hover:opacity-100 p-1 rounded transition-all ${
                                isPublished 
                                  ? 'text-gray-400 cursor-not-allowed' 
                                  : 'text-red-600 hover:text-red-800 hover:bg-red-50'
                              }`}
                              title={isPublished ? "Cannot be deleted while published" : "Delete unpublished lexicon"}
                              disabled={deletingLexicon === blob || isPublished}
                            >
                              {deletingLexicon === blob ? (
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-600"></div>
                              ) : (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* New Lexicon Modal */}
        {showNewLexiconModal && (
          <>
            <div className="modal-backdrop" onClick={() => setShowNewLexiconModal(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="new-lexicon-title">
              <div className="modal-content">
                <div className="flex justify-between items-center mb-4">
                  <h2 id="new-lexicon-title" className="text-xl font-semibold">Create New Lexicon</h2>
                  <button
                    onClick={() => setShowNewLexiconModal(false)}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close modal"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="space-y-4">
                  <div>
                    <label htmlFor="new-lexicon-name" className="block text-sm font-medium text-gray-700 mb-1">
                      Lexicon Name
                    </label>
                    <input
                      type="text"
                      id="new-lexicon-name"
                      value={newLexiconName}
                      onChange={(e) => setNewLexiconName(e.target.value)}
                      placeholder="Enter lexicon name (e.g., my-lexicon.xml)"
                      className="w-full p-2.5 rounded-lg border border-gray-300 text-gray-800 focus:ring-2 focus:ring-gray-500 focus:border-gray-500 bg-white text-base shadow-sm"
                      aria-describedby="new-lexicon-name-help"
                    />
                    <p id="new-lexicon-name-help" className="mt-1 text-xs text-gray-500">
                      Lexicon names must use only letters, numbers, hyphens, and underscores. The <code>.xml</code> extension will be added automatically if omitted.
                    </p>
                    {newLexiconError && (
                      <p className="mt-1 text-sm text-red-500" role="alert">{newLexiconError}</p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="new-lexicon-lang" className="block text-sm font-medium text-gray-700 mb-1">
                      Language
                    </label>
                    <select
                      id="new-lexicon-lang"
                      value={newLexiconLang}
                      onChange={e => {
                        setNewLexiconLang(e.target.value);
                        setSelectedLanguage(e.target.value);
                      }}
                      className="w-full p-2.5 rounded-lg border border-gray-300 text-gray-800 focus:ring-2 focus:ring-gray-500 focus:border-gray-500 bg-white text-base shadow-sm"
                      aria-label="Select language"
                    >
                      <option value="" className="text-gray-500" disabled>Select a language</option>
                      {LANGUAGES.map(lang => (
                        <option key={lang.id} value={lang.id} className="text-gray-800">{lang.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => setShowNewLexiconModal(false)}
                      className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                      aria-label="Cancel creating new lexicon"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateNewLexicon}
                      className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-700 text-white hover:bg-gray-800 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                      aria-label="Create new lexicon"
                    >
                      Create
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Import Modal */}
        {showImportModal && (
          <>
            <div className="modal-backdrop" onClick={() => { setShowImportModal(false); setPendingImportFile(null); setPendingLexiconSwitch(null); }} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="import-modal-title">
              <div className="modal-content">
                <div id="import-modal-title" className="mb-4 text-lg font-semibold">Abandon current lexicon?</div>
                <div className="mb-4 text-gray-700">This will abandon the currently open lexicon. What would you like to do?</div>
                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => { setShowImportModal(false); setPendingImportFile(null); setPendingLexiconSwitch(null); }}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Cancel import"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setShowImportModal(false);
                      setPendingImportFile(null);
                      if (pendingLexiconSwitch) {
                        handleSaveLexicon().then(() => {
                          pendingLexiconSwitch();
                          setPendingLexiconSwitch(null);
                        });
                      } else {
                        handleSaveLexicon().then(() => {
                          if (pendingImportFile) importLexiconFile(pendingImportFile);
                        });
                      }
                    }}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-700 text-white hover:bg-gray-800 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Save and continue"
                  >
                    Save & Continue
                  </button>
                  <button
                    onClick={() => {
                      setShowImportModal(false);
                      if (pendingLexiconSwitch) {
                        pendingLexiconSwitch();
                        setPendingLexiconSwitch(null);
                      } else {
                        if (pendingImportFile) importLexiconFile(pendingImportFile);
                        setPendingImportFile(null);
                      }
                    }}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-red-600 text-white hover:bg-red-700 focus:ring-2 focus:ring-red-500 focus:outline-none"
                    aria-label="Discard and continue"
                  >
                    Discard & Continue
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Export Format Selection Modal */}
        {showExportFormatModal && (
          <>
            <div className="modal-backdrop" onClick={() => setShowExportFormatModal(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="export-format-title">
              <div className="modal-content">
                <div id="export-format-title" className="mb-4 text-lg font-semibold">Choose Export Format</div>
                <div className="mb-4 text-gray-700">Select the format for exporting your lexicon:</div>
                <div className="flex flex-col gap-3 mb-6">
                  <button
                    onClick={() => handleExportFormat('xml')}
                    className="px-4 py-3 text-left rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all duration-200"
                  >
                    <div className="font-medium text-gray-900">XML Format</div>
                    <div className="text-sm text-gray-600">Standard PLS (Pronunciation Lexicon Specification) format for TTS engines</div>
                  </button>
                  <button
                    onClick={() => handleExportFormat('tsv')}
                    className="px-4 py-3 text-left rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all duration-200"
                  >
                    <div className="font-medium text-gray-900">CSV Format</div>
                    <div className="text-sm text-gray-600">Comma-separated values with proper quoting for Excel compatibility</div>
                  </button>
                </div>
                <div className="flex justify-end">
                  <button
                    onClick={() => setShowExportFormatModal(false)}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Cancel export"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Import Save Prompt */}
        {showImportSavePrompt && (
          <>
            <div className="modal-backdrop" onClick={() => setShowImportSavePrompt(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="import-save-title">
              <div className="modal-content">
                <div id="import-save-title" className="mb-4 text-lg font-semibold">Upload imported lexicon?</div>
                <div className="mb-4 text-gray-700">Would you like to upload this lexicon to blob storage now, or make changes before saving?</div>
                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => setShowImportSavePrompt(false)}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Edit first"
                  >
                    Edit First
                  </button>
                  <button
                    onClick={() => {
                      setShowImportSavePrompt(false);
                      handleSaveLexicon();
                    }}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-700 text-white hover:bg-gray-800 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Upload now"
                  >
                    Upload
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Save As Modal */}
        {showSaveAsModal && (
          <>
            <div className="modal-backdrop" onClick={() => setShowSaveAsModal(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="save-as-title">
              <div className="modal-content">
                <div id="save-as-title" className="mb-4 text-lg font-semibold">Rename Lexicon</div>
                <input
                  type="text"
                  id="save-as-filename"
                  name="save-as-filename"
                  value={saveAsFilename}
                  onChange={e => setSaveAsFilename(e.target.value)}
                  className="w-full p-2.5 rounded-lg border border-gray-300 text-gray-800 focus:ring-2 focus:ring-gray-500 focus:border-gray-500 bg-white text-base shadow-sm"
                  placeholder="Enter new file name (e.g., my-lexicon.xml)"
                  autoFocus
                  aria-label="New lexicon name"
                />
                {saveAsError && <div className="mt-2 text-red-500 text-sm" role="alert">{saveAsError}</div>}
                <div className="flex justify-end gap-3 mt-4">
                  <button
                    onClick={() => setShowSaveAsModal(false)}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Cancel rename"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveAsConfirm}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-700 text-white hover:bg-gray-800 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Confirm rename"
                  >
                    Rename
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Overwrite Modal */}
        {showOverwriteModal && (
          <>
            <div className="modal-backdrop" onClick={() => setShowOverwriteModal(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="overwrite-title">
              <div className="modal-content">
                <div id="overwrite-title" className="mb-4 text-lg font-semibold">Overwrite File?</div>
                <div className="mb-4 text-gray-700">A lexicon with this name already exists. Overwrite?</div>
                <div className="flex justify-end gap-3 mt-4">
                  <button
                    onClick={() => setShowOverwriteModal(false)}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Cancel overwrite"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleOverwriteConfirm}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-red-600 text-white hover:bg-red-700 focus:ring-2 focus:ring-red-500 focus:outline-none"
                    aria-label="Confirm overwrite"
                  >
                    Overwrite
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Delete Confirmation Modal */}
        {showDeleteModal && lexiconToDelete && (
          <>
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60]" onClick={() => setShowDeleteModal(false)} role="presentation" />
            <div className="fixed inset-0 flex items-center justify-center z-[70]" role="dialog" aria-labelledby="delete-title">
              <div className="bg-white rounded-xl shadow-2xl p-6 w-full max-w-md mx-4 transform transition-transform duration-200 ease-in-out border border-red-200">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex-shrink-0">
                    <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.732-.833-2.5 0L4.268 18.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                  </div>
                  <div>
                    <div id="delete-title" className="text-lg font-semibold text-red-600">Delete Lexicon</div>
                    <div className="text-sm text-gray-500">This action cannot be undone</div>
                  </div>
                </div>
                
                <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-red-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <div className="text-red-800 font-medium mb-1">⚠️ Warning: Permanent Deletion</div>
                      <div className="text-red-700 text-sm">
                        You are about to permanently delete <strong className="font-semibold">{lexiconToDelete}</strong>.
                        <br />
                        <br />
                        This will:
                        <ul className="list-disc list-inside mt-2 space-y-1">
                          <li>Remove it from the lexicon editor</li>
                          <li>Make it inaccessible for future use</li>
                        </ul>
                        <br />
                        <strong>This action cannot be undone.</strong>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="flex justify-end gap-3 mt-6">
                  <button
                    onClick={() => {
                      setShowDeleteModal(false);
                      setLexiconToDelete(null);
                    }}
                    className="px-6 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Cancel deletion"
                    disabled={deletingLexicon === lexiconToDelete}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => handleDeleteLexicon(lexiconToDelete)}
                    className="px-6 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-red-600 text-white hover:bg-red-700 focus:ring-2 focus:ring-red-500 focus:outline-none disabled:opacity-50 shadow-sm"
                    aria-label="Confirm deletion"
                    disabled={deletingLexicon === lexiconToDelete}
                  >
                    {deletingLexicon === lexiconToDelete ? (
                      <div className="flex items-center gap-2">
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                        Deleting...
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                        Delete Permanently
                      </div>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Toast Banner */}
        {toast && (
          <div 
            className={`fixed top-6 left-1/2 transform -translate-x-1/2 z-50 px-6 py-3 rounded-lg shadow-lg text-white ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}
            role="status" 
            aria-live="polite"
          >
            {toast.message}
          </div>
        )}


        {/* Merge Modal */}
        {showMergeModal && (
          <>
            <div className="modal-backdrop" onClick={() => setShowMergeModal(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="merge-modal-title">
              <div className="modal-content-wide" style={{ maxHeight: '80vh' }}>
                <div className="flex justify-between items-center mb-4">
                  <h2 id="merge-modal-title" className="text-xl font-semibold">Merge Lexicon</h2>
                  <button
                    onClick={() => setShowMergeModal(false)}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close modal"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(80vh - 80px)' }}>
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <p className="text-blue-800 text-sm">
                      <strong>Master Lexicon:</strong> {currentFile} ({findLanguageById(newLexiconLang)?.name || newLexiconLang})
                    </p>
                  </div>
                  {mergeFile && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                      <p className="text-green-800 text-sm">
                        <strong>Merge File:</strong> {mergeFileName} ({findLanguageById(mergeLanguage)?.name || mergeLanguage})
                      </p>
                    </div>
                  )}
                  
                  {/* Pronunciation Priority Information */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-blue-500 font-bold">ℹ</span>
                      <span className="text-blue-700 font-medium text-xs">Pronunciation Priority</span>
                    </div>
                    <div className="text-blue-800 text-xs">
                      <p><strong>IPA (phoneme)</strong> takes priority over <strong>Alias</strong> in TTS engines. Both can coexist for maximum compatibility.</p>
                    </div>
                  </div>
                  
                  {mergeDetailedErrors.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-2">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-red-500 font-bold">🚫</span>
                        <span className="text-red-700 font-medium text-xs">BLOCKING ERRORS - Merge Cannot Proceed:</span>
                      </div>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 max-h-40 overflow-y-auto">
                        {mergeDetailedErrors.map((error, idx) => (
                          <div key={idx} className="bg-white border border-red-200 rounded p-1 text-xs">
                            <div className="flex items-start gap-1 mb-1">
                              <span className="text-red-500 font-bold">#{idx + 1}</span>
                              <div className="flex-1">
                                <div className="font-medium text-red-800 mb-1">
                                  {error.message}
                                </div>
                                {error.lineNumber && (
                                  <div className="text-red-600 text-xs">
                                    <strong>Line:</strong> {error.lineNumber}
                                  </div>
                                )}
                                {error.entryContent && (
                                  <div className="text-red-600 text-xs">
                                    <strong>Entry:</strong> {error.entryContent}
                                  </div>
                                )}
                                {error.suggestion && (
                                  <div className="text-red-700 bg-red-100 p-1 rounded text-xs">
                                    <strong>💡</strong> {error.suggestion}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-1 text-xs text-red-600">
                        <strong>⚠️ CRITICAL:</strong> Merge is BLOCKED - fix errors in source file before proceeding.
                      </div>
                    </div>
                  )}
                  
                  {/* Processing Summary and Merge Preview - Side by Side */}
                  {mergeFileContent.length > 0 && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {/* Processing Summary */}
                      <div className="bg-gray-50 border border-gray-200 rounded-lg p-2">
                        <div className="flex items-center gap-2 mb-1">
                        <span className="text-gray-500 font-bold">📊</span>
                          <span className="text-gray-700 font-medium text-xs">Processing Summary</span>
                      </div>
                        <div className="text-gray-800 text-xs space-y-1">
                        <div className="flex justify-between">
                            <span>Processed:</span>
                          <span className="font-medium text-green-600">{mergeFileContent.length}</span>
                        </div>
                        {mergeDetailedErrors.length > 0 && (
                          <div className="flex justify-between">
                              <span>Errors:</span>
                            <span className="font-medium text-orange-600">{mergeDetailedErrors.length}</span>
                          </div>
                        )}
                        <div className="flex justify-between">
                            <span>Total:</span>
                          <span className="font-medium">{mergeFileContent.length + mergeDetailedErrors.length}</span>
                        </div>
                      </div>
                      </div>

                      {/* Merge Preview */}
                      {mergePreview && (
                        <div className={`border rounded-lg p-2 ${
                          mergePreview.errors > 0 
                            ? 'bg-red-50 border-red-200' 
                            : 'bg-blue-50 border-blue-200'
                        }`}>
                          <div className="flex items-center gap-2 mb-2">
                            <span className={`font-bold ${
                              mergePreview.errors > 0 ? 'text-red-500' : 'text-blue-500'
                            }`}>
                              {mergePreview.errors > 0 ? '🚫' : '🔍'}
                            </span>
                            <span className={`font-medium text-xs ${
                              mergePreview.errors > 0 ? 'text-red-700' : 'text-blue-700'
                            }`}>
                              {mergePreview.errors > 0 ? 'Merge BLOCKED' : 'Merge Preview'}
                            </span>
                          </div>
                          <div className={`text-xs space-y-1 ${
                            mergePreview.errors > 0 ? 'text-red-800' : 'text-blue-800'
                          }`}>
                            <div className="grid grid-cols-2 gap-1">
                              <div className="flex justify-between">
                                <span>New:</span>
                                <span className="font-medium text-green-600">{mergePreview.newEntries}</span>
                              </div>
                              <div className="flex justify-between">
                                <span>Conflicts:</span>
                                <span className="font-medium text-red-600">{mergePreview.conflicts}</span>
                              </div>
                              <div className="flex justify-between">
                                <span>Skipped:</span>
                                <span className="font-medium text-gray-600">{mergePreview.identicalSkipped}</span>
                              </div>
                              {mergePreview.errors > 0 && (
                                <div className="flex justify-between col-span-2">
                                  <span>BLOCKING Errors:</span>
                                  <span className="font-medium text-red-600">{mergePreview.errors}</span>
                    </div>
                  )}
                            </div>
                          </div>
                          
                          {mergePreview.potentialIssues.length > 0 && (
                            <div className="mt-2">
                              <div className={`font-medium text-xs mb-1 ${
                                mergePreview.errors > 0 ? 'text-red-700' : 'text-blue-700'
                              }`}>
                                {mergePreview.errors > 0 ? 'BLOCKING Issues:' : 'Issues:'}
                              </div>
                              <div className="space-y-1 max-h-16 overflow-y-auto">
                                {mergePreview.potentialIssues.slice(0, 2).map((issue, idx) => (
                                  <div key={idx} className={`text-xs p-1 rounded ${
                                    issue.type === 'conflict' ? 'bg-red-100 text-red-700' :
                                    issue.type === 'duplicate' ? 'bg-blue-100 text-blue-700' :
                                    'bg-red-100 text-red-700'
                                  }`}>
                                    {issue.message}
                                  </div>
                                ))}
                                {mergePreview.potentialIssues.length > 2 && (
                                  <div className={`text-xs italic ${
                                    mergePreview.errors > 0 ? 'text-red-600' : 'text-blue-600'
                                  }`}>
                                    ... and {mergePreview.potentialIssues.length - 2} more
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Blocking Error Message */}
                  {mergeDetailedErrors.length > 0 && (
                    <div className="bg-red-100 border-2 border-red-300 rounded-lg p-2">
                      <p className="text-red-700 text-xs mb-2">
                        {mergeDetailedErrors.length} error{mergeDetailedErrors.length > 1 ? 's' : ''} found - fix in source file before merge can proceed.
                      </p>
                      <div className="flex gap-2">
                        <div className="relative group">
                          <button
                            disabled
                            className="px-3 py-1 text-xs rounded-lg font-medium transition-all duration-200 bg-gray-400 text-gray-200 cursor-not-allowed"
                            aria-label="Edit file to fix errors (coming soon)"
                          >
                            ✏️ Edit File
                          </button>
                          <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-gray-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-10">
                            Coming soon!
                            <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-800"></div>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            setShowMergeModal(false);
                            setToast({ 
                              type: 'success', 
                              message: 'Merge cancelled. Fix errors in your source file and try again.' 
                            });
                          }}
                          className="px-3 py-1 text-xs rounded-lg font-medium transition-all duration-200 bg-gray-600 text-white hover:bg-gray-700 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                          aria-label="Cancel merge"
                        >
                          Cancel Merge
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="flex justify-between items-center gap-3">
                    <div className="flex-1">
                      {mergeFile ? (
                        <div className="p-2.5 rounded-lg border border-gray-300 bg-gray-50 text-gray-800 text-base">
                          <div className="text-sm font-medium text-gray-700 mb-1">Selected File:</div>
                          <div className="flex items-center gap-2">
                            <div className="text-sm flex-1">{mergeFileName}</div>
                            <button
                              onClick={() => {
                                setMergeFile(null);
                                setMergeFileName('');
                                setMergeLanguage('');
                                setMergeFileContent([]);
                                setMergeConflicts([]);
                                setMergeDetailedErrors([]);
                                setMergePreview(null);
                                setMergeErrors([]);
                                if (mergeFileInputRef.current) {
                                  mergeFileInputRef.current.value = '';
                                }
                              }}
                              className="px-2 py-1 text-xs rounded font-medium transition-all duration-200 bg-gray-200 text-gray-700 hover:bg-gray-300 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                              aria-label="Change selected file"
                            >
                              Change
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <label htmlFor="merge-file" className="block text-sm font-medium text-gray-700 mb-1">
                            Select Vendor Lexicon to Merge
                          </label>
                          <input
                            ref={mergeFileInputRef}
                            type="file"
                            id="merge-file"
                            accept=".xml"
                            onChange={handleMergeFileChange}
                            className="w-full p-2.5 rounded-lg border border-gray-300 text-gray-800 focus:ring-2 focus:ring-gray-500 focus:border-gray-500 bg-white text-base shadow-sm"
                            aria-describedby="merge-file-help"
                          />
                          <p id="merge-file-help" className="mt-1 text-xs text-gray-500">
                            Select a lexicon file to merge with the master lexicon. Languages must match.
                          </p>
                        </>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <button
                        onClick={() => setShowMergeModal(false)}
                        className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                        aria-label="Cancel merge"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Conflict Resolution Modal */}
        {showConflictResolution && (
          <>
            <div className="modal-backdrop" onClick={() => setShowConflictResolution(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="conflict-resolution-title">
              <div className="modal-content-wide">
                <div className="flex justify-between items-center mb-4">
                  <h2 id="conflict-resolution-title" className="text-xl font-semibold">Resolve Merge Conflicts</h2>
                  <button
                    onClick={() => setShowConflictResolution(false)}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close modal"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {/* Bulk Merge Options */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 mb-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-gray-500 font-bold">⚡</span>
                    <span className="text-gray-700 font-medium text-sm">Bulk Merge Options</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => resolveAllConflicts('both')}
                      className="px-3 py-2 text-sm rounded-lg font-medium transition-all duration-200 bg-blue-100 text-blue-700 hover:bg-blue-200"
                      aria-label="Merge all conflicts"
                    >
                      Merge All
                    </button>
                    <button
                      onClick={() => resolveAllConflicts('master')}
                      className="px-3 py-2 text-sm rounded-lg font-medium transition-all duration-200 bg-red-100 text-red-700 hover:bg-red-200"
                      aria-label="Keep all master versions"
                    >
                      Keep All Master
                    </button>
                    <button
                      onClick={() => resolveAllConflicts('merge')}
                      className="px-3 py-2 text-sm rounded-lg font-medium transition-all duration-200 bg-green-100 text-green-700 hover:bg-green-200"
                      aria-label="Keep all file versions"
                    >
                      Keep All File
                    </button>
                    {mergeConflicts.some(c => c.type === 'additional_alias') && (
                      <>
                        <div className="w-px h-8 bg-gray-300 mx-1"></div>
                        <button
                          onClick={() => resolveAllAdditionalAliases('both')}
                          className="px-3 py-2 text-sm rounded-lg font-medium transition-all duration-200 bg-purple-100 text-purple-700 hover:bg-purple-200"
                          aria-label="Merge all additional aliases"
                        >
                          Merge All Aliases
                        </button>
                      </>
                    )}
                    {mergeConflicts.some(c => c.type === 'conflict') && (
                      <>
                        <div className="w-px h-8 bg-gray-300 mx-1"></div>
                        <button
                          onClick={() => resolveAllConflictsOnly('both')}
                          className="px-3 py-2 text-sm rounded-lg font-medium transition-all duration-200 bg-orange-100 text-orange-700 hover:bg-orange-200"
                          aria-label="Merge all content conflicts only"
                        >
                          Merge All Conflicts
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="space-y-4 max-h-96 overflow-y-auto border border-gray-200 rounded-lg" style={{ scrollbarWidth: 'thin', scrollbarColor: '#d1d5db #f3f4f6' }}>
                  <div className="text-xs text-gray-500 text-center py-2 bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
                    ↕ Scroll to see all conflicts ({mergeConflicts.length} total)
                  </div>
                  {mergeConflicts.map((conflict, index) => (
                    <div key={index} className="border-b border-gray-100 last:border-b-0 p-4 bg-white">
                      <div className="mb-3">
                        <h3 className="font-medium text-gray-900 mb-1 flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-gray-500 bg-gray-200 px-2 py-1 rounded">
                            {conflict.type === 'additional_alias' ? 'Additional Alias' : 'Content Conflict'}
                          </span>
                          <span>Conflict {index + 1}: {conflict.commonGraphemes.join(', ')}</span>
                        </h3>
                      </div>
                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <div className="border border-red-200 rounded-lg p-3 bg-red-50 flex flex-col">
                          <div className="flex items-start gap-2 mb-2" style={{ minHeight: '2.5rem' }}>
                            <span className="bg-red-600 text-white px-2 py-1 rounded text-xs flex-shrink-0">MASTER</span>
                            <span className="text-xs text-red-800 font-medium leading-tight break-all">{currentFile}</span>
                          </div>
                          <div className="text-sm text-red-700 flex-1">
                            <p><strong>Graphemes:</strong> {conflict.masterEntry.graphemes.join(', ')}</p>
                            <p><strong>Alias:</strong> {conflict.masterEntry.alias || '(none)'}</p>
                            <p><strong>Phoneme:</strong> {conflict.masterEntry.phoneme || '(none)'}</p>
                          </div>
                        </div>
                        <div className="border border-green-200 rounded-lg p-3 bg-green-50 flex flex-col">
                          <div className="flex items-start gap-2 mb-2" style={{ minHeight: '2.5rem' }}>
                            <span className="bg-green-600 text-white px-2 py-1 rounded text-xs flex-shrink-0">*FILE*</span>
                            <span className="text-xs text-green-800 font-medium leading-tight break-all">{mergeFileName}</span>
                          </div>
                          <div className="text-sm text-green-700 flex-1">
                            <p><strong>Graphemes:</strong> {conflict.mergeEntry.graphemes.join(', ')}</p>
                            <p><strong>Alias:</strong> {conflict.mergeEntry.alias || '(none)'}</p>
                            <p><strong>Phoneme:</strong> {conflict.mergeEntry.phoneme || '(none)'}</p>
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => handleConflictResolution(index, 'both')}
                          className={`px-3 py-2 text-sm rounded-lg font-medium transition-all duration-200 ${
                            conflict.resolution === 'both' 
                              ? 'bg-blue-600 text-white' 
                              : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                          }`}
                          aria-label={`Merge both versions for conflict ${index + 1}`}
                        >
                          Merge Both
                        </button>
                        <button
                          onClick={() => handleConflictResolution(index, 'master')}
                          className={`px-3 py-2 text-sm rounded-lg font-medium transition-all duration-200 ${
                            conflict.resolution === 'master' 
                              ? 'bg-red-600 text-white' 
                              : 'bg-red-100 text-red-700 hover:bg-red-200'
                          }`}
                          aria-label={`Keep master version for conflict ${index + 1}`}
                        >
                          Keep Master
                        </button>
                        <button
                          onClick={() => handleConflictResolution(index, 'merge')}
                          className={`px-3 py-2 text-sm rounded-lg font-medium transition-all duration-200 ${
                            conflict.resolution === 'merge' 
                              ? 'bg-green-600 text-white' 
                              : 'bg-green-100 text-green-700 hover:bg-green-200'
                          }`}
                          aria-label={`Keep file version for conflict ${index + 1}`}
                        >
                          Keep File
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end gap-3 mt-6">
                  <button
                    onClick={() => setShowConflictResolution(false)}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                    aria-label="Cancel conflict resolution"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={finalizeMerge}
                    disabled={mergeConflicts.some(c => !c.resolution)}
                    className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-700 text-white hover:bg-gray-800 focus:ring-2 focus:ring-gray-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Complete merge"
                  >
                    Complete Merge ({mergeConflicts.filter(c => c.resolution).length}/{mergeConflicts.length} resolved)
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Preview Modal */}
        {showPreviewModal && (
          <>
            <div className="modal-backdrop" onClick={() => setShowPreviewModal(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="preview-title" style={{ maxWidth: '90vw', maxHeight: '90vh' }}>
              <div className="modal-content" style={{ width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none' }}>
                <div className="flex justify-between items-center mb-4">
                  <div id="preview-title" className="text-lg font-semibold">TTS Preview</div>
                  <button
                    onClick={() => setShowPreviewModal(false)}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close preview"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="flex-1" style={{ height: 'calc(100% - 60px)' }}>
                  {showPreviewIframe ? (
                    <iframe
                      src={previewUrl}
                      title="TTS Preview"
                      className="w-full h-full border-0 rounded-lg"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                      allow="microphone"
                      onLoad={(e) => {
                        const iframe = e.target as HTMLIFrameElement;
                        // Send TTS key after a small delay to ensure iframe is fully loaded
                        setTimeout(() => {
                          sendTtsKeyToIframe(iframe);
                        }, 1000);
                      }}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full">
                      <div className="text-center">
                        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-4" aria-hidden="true"></div>
                        <p className="text-gray-600">Generating audio preview...</p>
                        <button
                          onClick={() => setShowPreviewIframe(true)}
                          className="mt-4 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                        >
                          Show TTS Interface
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}



        {/* Floating Preview UI */}
        {showFloatingPreview && previewButtonRef && previewUrl && (
          <div 
            className="fixed z-50 bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden"
            style={{
              top: `${previewButtonRef.getBoundingClientRect().top - 80}px`,
              left: `${previewButtonRef.getBoundingClientRect().left}px`,
              width: '400px',
              height: '300px'
            }}
          >
            <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                <span className="text-sm font-medium text-gray-700">TTS Preview</span>
              </div>
              <button
                onClick={() => {
                  if (previewTimeoutRef.current) {
                    clearTimeout(previewTimeoutRef.current);
                    previewTimeoutRef.current = null;
                  }
                  setShowFloatingPreview(false);
                }}
                className="text-gray-400 hover:text-gray-600 transition-colors"
                aria-label="Close preview"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="p-3 text-center">
              <div className="text-sm text-gray-600 mb-2">Loading TTS interface...</div>
              <div className="text-xs text-gray-500 mb-3">
                If the interface doesn't load, <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">click here to open in new tab</a>
              </div>
            </div>
            
            <iframe
              src={previewUrl}
              title="TTS Preview"
              className="w-full"
              style={{ height: 'calc(100% - 120px)', border: 'none' }}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation"
              allow="microphone; autoplay"
              onLoad={(e) => {
                const iframe = e.target as HTMLIFrameElement;
                // Send TTS key after a small delay to ensure iframe is fully loaded
                setTimeout(() => {
                  sendTtsKeyToIframe(iframe);
                }, 1000);
              }}
            />
          </div>
        )}

        {/* Publish to Web-TTS Modal */}
        {showPublishModal && (
          <>
            <div className="modal-backdrop" onClick={() => setShowPublishModal(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="publish-modal-title">
              <div className="modal-content">
                <div className="flex justify-between items-center mb-4">
                  <h2 id="publish-modal-title" className="text-xl font-semibold">Publish to TTS Tool</h2>
                  <button
                    onClick={() => setShowPublishModal(false)}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close modal"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="space-y-4">
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-yellow-500 font-bold">⚠</span>
                      <span className="text-yellow-700 font-medium text-sm">Publish to TTS Tool</span>
                    </div>
                    
                    <div className="space-y-2 mb-3">
                      <p className="text-yellow-800 text-sm">
                        <strong>Lexicon:</strong> {currentFile}
                      </p>
                      <p className="text-yellow-800 text-sm">
                        <strong>Language:</strong> {findLanguageById(newLexiconLang)?.name || newLexiconLang}
                      </p>
                    </div>
                    
                    <div className="border-t border-yellow-200 pt-3">
                      <p className="text-yellow-700 text-sm font-medium mb-2">Important:</p>
                      <ul className="text-yellow-600 text-sm space-y-1">
                        <li>• This will make the lexicon available in the TTS application</li>
                        <li>• Only publish when you're ready - this affects the live TTS system</li>
                      </ul>
                    </div>
                  </div>

                  {publishError && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-red-500 font-bold">⚠</span>
                        <span className="text-red-700 font-medium text-sm">Error:</span>
                      </div>
                      <p className="text-red-600 text-sm">{publishError}</p>
                    </div>
                  )}

                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => setShowPublishModal(false)}
                      className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                      aria-label="Cancel publishing"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handlePublishToWebTTS}
                      disabled={publishLoading}
                      className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-700 text-white hover:bg-gray-800 focus:ring-2 focus:ring-gray-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Publish lexicon to TTS tool"
                    >
                      {publishLoading ? 'Publishing...' : 'Publish to TTS Tool'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Remove from Web-TTS Modal */}
        {showRemoveModal && (
          <>
            <div className="modal-backdrop" onClick={() => setShowRemoveModal(false)} role="presentation" />
            <div className="modal-container" role="dialog" aria-labelledby="remove-modal-title">
              <div className="modal-content">
                <div className="flex justify-between items-center mb-4">
                  <h2 id="remove-modal-title" className="text-xl font-semibold">Remove from TTS Tool</h2>
                  <button
                    onClick={() => setShowRemoveModal(false)}
                    className="text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close modal"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="space-y-4">
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                    <p className="text-red-800 text-sm">
                      <strong>Warning:</strong> This will remove the lexicon from the TTS tool's settings.xml file.
                    </p>
                    <p className="text-red-800 text-sm">
                      The lexicon will no longer be available in the TTS application.
                    </p>
                  </div>

                  {removeError && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-red-500 font-bold">⚠</span>
                        <span className="text-red-700 font-medium text-sm">Error:</span>
                      </div>
                      <p className="text-red-600 text-sm">{removeError}</p>
                    </div>
                  )}

                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => setShowRemoveModal(false)}
                      className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-2 focus:ring-gray-500 focus:outline-none"
                      aria-label="Cancel removal"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleRemoveFromWebTTS}
                      disabled={removeLoading}
                      className="px-4 py-2 text-base rounded-lg font-medium transition-all duration-200 bg-red-600 text-white hover:bg-red-700 focus:ring-2 focus:ring-red-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                      aria-label="Remove lexicon from TTS tool"
                    >
                      {removeLoading ? 'Removing...' : 'Remove from TTS Tool'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Preview Iframe - Positioned below the main app */}
        {showEmbeddedPreview && previewUrl && (
          <div className="mt-4 max-w-[900px] mx-auto">
            <div className="bg-white rounded-xl shadow-lg border border-gray-200 overflow-hidden">
              <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                  <span className="text-sm font-medium text-gray-700">Previewing</span>
                </div>
              </div>
              <iframe
                src={previewUrl}
                title="TTS Preview"
                className="w-full"
                style={{ height: '200px', border: 'none' }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                allow="microphone"
                onLoad={(e) => {
                  const iframe = e.target as HTMLIFrameElement;
                  // Send TTS key after a small delay to ensure iframe is fully loaded
                  setTimeout(() => {
                    sendTtsKeyToIframe(iframe);
                  }, 1000);
                }}
              />
            </div>
          </div>
        )}
      </div>
      </div>
    </ProtectedRoute>
  );
}

export default App;
