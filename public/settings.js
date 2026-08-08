/* ==========================================================
   PrisJagt - AI Configuration & Settings Logic
   ========================================================= */

'use strict';

// --- DOM References ---
const settingsToggleBtn = document.getElementById('settings-toggle-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const settingsForm = document.getElementById('settings-form');
const settingsProvider = document.getElementById('settings-provider');

// Panels
const panelApi = document.getElementById('settings-panel-api');
const panelOllama = document.getElementById('settings-panel-ollama');

// Inputs inside panelApi
const apiKeyInput = document.getElementById('settings-api-key');
const apiModelInput = document.getElementById('settings-api-model');
const apiUrlGroup = document.getElementById('settings-api-url-group');
const apiUrlInput = document.getElementById('settings-api-url');
const keyLabel = document.getElementById('settings-key-label');
const keyHelp = document.getElementById('settings-key-help');

// Inputs inside panelOllama
const ollamaUrlInput = document.getElementById('settings-ollama-url');
const ollamaModelInput = document.getElementById('settings-ollama-model');

// General UI elements
const settingsTestBtn = document.getElementById('settings-test-btn');
const settingsTestResult = document.getElementById('settings-test-result');
const aiStatusBadge = document.getElementById('ai-status-badge');
const tabBtnRecipe = document.getElementById('tab-btn-recipe');

// --- Default Models & Labels ---
const PROVIDER_DEFAULTS = {
  gemini: {
    model: 'gemini-2.0-flash',
    label: 'Gemini API-nøgle',
    help: 'Hvis du lader feltet stå tomt, bruges <code>GEMINI_API_KEY</code> fra serverens <code>.env</code>.',
    showUrl: false
  },
  anthropic: {
    model: 'claude-3-5-sonnet-20241022',
    label: 'Anthropic/Claude API-nøgle',
    help: 'Hvis du lader feltet stå tomt, bruges <code>CLAUDE_API_KEY</code> eller <code>ANTHROPIC_API_KEY</code> fra serverens <code>.env</code>.',
    showUrl: false
  },
  deepseek: {
    model: 'deepseek-chat',
    label: 'DeepSeek API-nøgle',
    help: 'Hvis du lader feltet stå tomt, bruges <code>DEEPSEEK_API_KEY</code> fra serverens <code>.env</code>.',
    showUrl: false
  },
  mistral: {
    model: 'mistral-tiny',
    label: 'Mistral API-nøgle',
    help: 'Hvis du lader feltet stå tomt, bruges <code>MISTRAL_API_KEY</code> fra serverens <code>.env</code>.',
    showUrl: false
  },
  openai: {
    model: 'gpt-4o-mini',
    label: 'OpenAI / Kompatibel API-nøgle',
    help: 'Hvis du lader feltet stå tomt, bruges <code>OPENAI_API_KEY</code> fra serverens <code>.env</code>.',
    showUrl: true // Show base URL option (useful for LM Studio, Groq, OpenRouter)
  }
};

// --- State ---
let aiConfig = {
  connected: false,
  provider: 'gemini',
  apiKey: '',
  model: 'gemini-2.0-flash',
  baseUrl: '', // Used for OpenAI compatible
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3'
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  setupEventListeners();
  updateUIFromConfig();
});

// Load config from localStorage
function loadConfig() {
  const saved = localStorage.getItem('prisjagt_ai_config');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      aiConfig = { ...aiConfig, ...parsed };
    } catch (e) {
      console.error('Kunne ikke indlæse gemt AI-konfiguration:', e);
    }
  }
}

// Save config to localStorage
function saveConfig() {
  localStorage.setItem('prisjagt_ai_config', JSON.stringify(aiConfig));
}

// Update DOM elements based on loaded/saved config
function updateUIFromConfig() {
  settingsProvider.value = aiConfig.provider;
  
  if (aiConfig.provider !== 'ollama') {
    apiKeyInput.value = aiConfig.apiKey || '';
    apiModelInput.value = aiConfig.model || PROVIDER_DEFAULTS[aiConfig.provider]?.model || '';
    apiUrlInput.value = aiConfig.baseUrl || '';
  } else {
    ollamaUrlInput.value = aiConfig.ollamaUrl || 'http://localhost:11434';
    ollamaModelInput.value = aiConfig.ollamaModel || 'llama3';
  }

  toggleProviderPanels(aiConfig.provider);
  updateStatusBadge();
}

// Toggle visibility of settings panels based on provider
function toggleProviderPanels(provider) {
  if (provider === 'ollama') {
    panelApi.classList.add('hidden');
    panelOllama.classList.remove('hidden');
  } else {
    panelApi.classList.remove('hidden');
    panelOllama.classList.add('hidden');
    
    // Customize Labels and Inputs for specific Cloud Provider
    const defaults = PROVIDER_DEFAULTS[provider];
    if (defaults) {
      keyLabel.textContent = defaults.label;
      keyHelp.innerHTML = defaults.help;
      apiModelInput.placeholder = defaults.model;
      
      if (defaults.showUrl) {
        apiUrlGroup.classList.remove('hidden');
      } else {
        apiUrlGroup.classList.add('hidden');
      }
    }
  }
}

// Update the AI connection status indicator in the header
function updateStatusBadge() {
  const badgeText = aiStatusBadge.querySelector('.badge-text');
  
  if (aiConfig.connected) {
    aiStatusBadge.className = 'ai-badge connected';
    
    let displayProvider = aiConfig.provider;
    if (aiConfig.provider === 'anthropic') displayProvider = 'Claude';
    else if (aiConfig.provider === 'openai') displayProvider = 'OpenAI';
    else if (aiConfig.provider === 'mistral') displayProvider = 'Mistral';
    else if (aiConfig.provider === 'deepseek') displayProvider = 'DeepSeek';
    else displayProvider = displayProvider.charAt(0).toUpperCase() + displayProvider.slice(1);
    
    badgeText.textContent = `AI Tilkoblet (${displayProvider})`;
    tabBtnRecipe.classList.remove('ai-disabled');
  } else {
    aiStatusBadge.className = 'ai-badge disconnected';
    badgeText.textContent = 'AI Frakoblet';
    tabBtnRecipe.classList.add('ai-disabled');
  }
}

// --- Event Listeners Setup ---
function setupEventListeners() {
  // Modal open/close
  settingsToggleBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    settingsTestResult.className = 'test-result-box hidden';
    updateUIFromConfig(); // Reload form values correctly
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  // Close modal when clicking outside content card
  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      settingsModal.classList.add('hidden');
    }
  });

  // Provider dropdown change
  settingsProvider.addEventListener('change', (e) => {
    const provider = e.target.value;
    toggleProviderPanels(provider);
    
    // Auto-fill default model on provider change if user hasn't typed anything custom
    if (provider !== 'ollama' && PROVIDER_DEFAULTS[provider]) {
      apiModelInput.value = PROVIDER_DEFAULTS[provider].model;
    }
  });

  // Test Connection button
  settingsTestBtn.addEventListener('click', testConnection);

  // Save Settings form submit
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const provider = settingsProvider.value;
    aiConfig.provider = provider;
    
    if (provider !== 'ollama') {
      aiConfig.apiKey = apiKeyInput.value.trim();
      aiConfig.model = apiModelInput.value.trim() || PROVIDER_DEFAULTS[provider]?.model;
      aiConfig.baseUrl = apiUrlInput.value.trim();
    } else {
      aiConfig.ollamaUrl = ollamaUrlInput.value.trim();
      aiConfig.ollamaModel = ollamaModelInput.value.trim();
    }
    
    aiConfig.connected = true; 

    saveConfig();
    updateStatusBadge();
    settingsModal.classList.add('hidden');
    
    // Trigger custom event so recipe.js knows configuration changed
    window.dispatchEvent(new CustomEvent('aiConfigChanged', { detail: aiConfig }));
  });
}

// --- Connection Testing ---
async function testConnection() {
  const provider = settingsProvider.value;
  const body = { provider };

  if (provider !== 'ollama') {
    body.apiKey = apiKeyInput.value.trim();
    body.model = apiModelInput.value.trim() || PROVIDER_DEFAULTS[provider]?.model;
    body.baseUrl = apiUrlInput.value.trim();
  } else {
    body.baseUrl = ollamaUrlInput.value.trim();
    body.model = ollamaModelInput.value.trim();
  }

  showTestResult('Tester forbindelse...', 'pending');
  settingsTestBtn.disabled = true;

  try {
    const response = await fetch('/api/llm/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (response.ok && data.success) {
      showTestResult(`Succes! ${data.message}`, 'success');
      aiConfig.connected = true;
    } else {
      showTestResult(`Fejl: ${data.error || 'Uventet server fejl'}`, 'error');
      aiConfig.connected = false;
    }
  } catch (err) {
    showTestResult(`Kunne ikke nå serveren: ${err.message}`, 'error');
    aiConfig.connected = false;
  } finally {
    settingsTestBtn.disabled = false;
  }
}

function showTestResult(message, type) {
  settingsTestResult.textContent = message;
  settingsTestResult.className = `test-result-box ${type}`;
  settingsTestResult.classList.remove('hidden');
}

// Expose config getter to window
window.getAIConfig = function() {
  return aiConfig;
};
