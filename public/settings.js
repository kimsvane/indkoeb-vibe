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

// Providers that are globally configured via server environment variables
let serverConfiguredProviders = [];

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
  loadConfig();
  setupEventListeners();
  setupNotificationListeners();
  await detectServerConfig(); // Check server for globally configured API keys
  updateUIFromConfig();
  await loadNotificationConfig();
});

// Detect which LLM providers are globally configured via server env vars
async function detectServerConfig() {
  try {
    const res = await fetch('/api/llm/config');
    if (!res.ok) return;
    const data = await res.json();

    serverConfiguredProviders = data.availableProviders || [];

    if (serverConfiguredProviders.length > 0) {
      // If not already connected locally (e.g. new device/session), auto-connect via server config
      if (!aiConfig.connected) {
        aiConfig.provider = data.defaultProvider;
        aiConfig.model = PROVIDER_DEFAULTS[data.defaultProvider]?.model || '';
        aiConfig.connected = true;
        // Save to localStorage so the session knows it's connected
        saveConfig();
        console.log(`[Settings] Auto-connected via server config: ${data.defaultProvider}`);
      }
      // If user's stored provider is not globally configured, switch to one that is
      if (!serverConfiguredProviders.includes(aiConfig.provider) && aiConfig.provider !== 'ollama' && !aiConfig.apiKey) {
        aiConfig.provider = data.defaultProvider;
        aiConfig.model = PROVIDER_DEFAULTS[data.defaultProvider]?.model || '';
        aiConfig.connected = true;
        saveConfig();
      }
    }
  } catch (err) {
    console.warn('[Settings] Could not fetch server LLM config:', err.message);
  }
}

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
      apiModelInput.placeholder = defaults.model;
      
      if (defaults.showUrl) {
        apiUrlGroup.classList.remove('hidden');
      } else {
        apiUrlGroup.classList.add('hidden');
      }
    }
    
    // Show server-configured notice if this provider is globally configured
    updateServerConfigNotice(provider);
  }
}

// Show/hide a notice inside the API panel if the provider is globally configured on the server
function updateServerConfigNotice(provider) {
  let noticeEl = document.getElementById('server-config-notice');
  
  if (!noticeEl) {
    noticeEl = document.createElement('div');
    noticeEl.id = 'server-config-notice';
    noticeEl.className = 'server-config-notice';
    panelApi.insertBefore(noticeEl, panelApi.firstChild);
  }

  if (serverConfiguredProviders.includes(provider)) {
    noticeEl.innerHTML = `
      <span class="server-notice-icon">✓</span>
      <strong>${PROVIDER_DEFAULTS[provider]?.label || provider}</strong> er globalt konfigureret via servermiljøvariabel.
      Du behøver ikke at indtaste en API-nøgle — den bruges automatisk for alle brugere og enheder.
    `;
    noticeEl.style.display = 'flex';
    apiKeyInput.disabled = true;
    apiKeyInput.placeholder = '(Bruger serverens nøgle automatisk)';
  } else {
    noticeEl.style.display = 'none';
    apiKeyInput.disabled = false;
    const defaults = PROVIDER_DEFAULTS[provider];
    keyHelp.innerHTML = defaults?.help || '';
    apiKeyInput.placeholder = 'Indtast din API-nøgle...';
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

// --- Notifications Configuration ---
let notifConfig = { services: {} };

async function loadNotificationConfig() {
  try {
    const res = await fetch('/api/notifications');
    if (!res.ok) throw new Error('Fejl');
    notifConfig = await res.json();
    applyNotificationConfig();
  } catch (err) {
    console.warn('[Settings] Kunne ikke hente notifikationskonfiguration:', err.message);
  }
}

function applyNotificationConfig() {
  const s = notifConfig.services || {};
  const push = s.pushover || {};
  const email = s.email || {};
  const ha = s.homeassistant || {};

  const po = document.getElementById('notif-pushover-enabled');
  const e = document.getElementById('notif-email-enabled');
  const h = document.getElementById('notif-ha-enabled');
  if (po) po.checked = !!push.enabled;
  if (e) e.checked = !!email.enabled;
  if (h) h.checked = !!ha.enabled;

  if (push.appToken) document.getElementById('notif-pushover-token').value = push.appToken;
  if (push.userKey) document.getElementById('notif-pushover-user').value = push.userKey;

  if (email.smtpHost) document.getElementById('notif-email-host').value = email.smtpHost;
  if (email.smtpPort) document.getElementById('notif-email-port').value = email.smtpPort;
  if (email.smtpUser) document.getElementById('notif-email-user').value = email.smtpUser;
  if (email.smtpPass && email.smtpPass !== '***') document.getElementById('notif-email-pass').value = email.smtpPass;
  if (email.toEmail) document.getElementById('notif-email-to').value = email.toEmail;
  if (email.fromEmail) document.getElementById('notif-email-from').value = email.fromEmail;

  if (ha.baseUrl) document.getElementById('notif-ha-url').value = ha.baseUrl;
  if (ha.webhookId && ha.webhookId !== '***') document.getElementById('notif-ha-webhook').value = ha.webhookId;

  toggleNotifFields('pushover');
  toggleNotifFields('email');
  toggleNotifFields('homeassistant');
}

function toggleNotifFields(service) {
  const map = { pushover: 'notif-pushover-enabled', email: 'notif-email-enabled', homeassistant: 'notif-ha-enabled' };
  const el = document.getElementById(map[service]);
  if (!el) return;
  const fieldsMap = { pushover: 'notif-pushover-fields', email: 'notif-email-fields', homeassistant: 'notif-ha-fields' };
  const fields = document.getElementById(fieldsMap[service]);
  if (fields) fields.classList.toggle('hidden', !el.checked);
}

function setupNotificationListeners() {
  document.querySelectorAll('.notif-toggle').forEach(input => {
    input.addEventListener('change', () => {
      const map = { 'notif-pushover-enabled': 'pushover', 'notif-email-enabled': 'email', 'notif-ha-enabled': 'homeassistant' };
      toggleNotifFields(map[input.id]);
    });
  });

  const saveBtn = document.getElementById('notif-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', saveNotificationConfig);

  document.querySelectorAll('.notification-test-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'Sender...';
      try {
        await saveNotificationConfig(true);
        const res = await fetch('/api/notifications/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service: btn.dataset.service })
        });
        const data = await res.json();
        btn.textContent = data.ok ? 'Sendt ✓' : 'Fejl ✗';
      } catch (err) {
        btn.textContent = 'Fejl ✗';
      } finally {
        setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 2500);
      }
    });
  });
}

function collectNotificationConfig() {
  return {
    services: {
      pushover: {
        enabled: document.getElementById('notif-pushover-enabled').checked,
        appToken: document.getElementById('notif-pushover-token').value.trim(),
        userKey: document.getElementById('notif-pushover-user').value.trim()
      },
      email: {
        enabled: document.getElementById('notif-email-enabled').checked,
        smtpHost: document.getElementById('notif-email-host').value.trim(),
        smtpPort: parseInt(document.getElementById('notif-email-port').value) || 587,
        smtpUser: document.getElementById('notif-email-user').value.trim(),
        smtpPass: document.getElementById('notif-email-pass').value,
        toEmail: document.getElementById('notif-email-to').value.trim(),
        fromEmail: document.getElementById('notif-email-from').value.trim()
      },
      homeassistant: {
        enabled: document.getElementById('notif-ha-enabled').checked,
        baseUrl: document.getElementById('notif-ha-url').value.trim(),
        webhookId: document.getElementById('notif-ha-webhook').value.trim()
      }
    }
  };
}

async function saveNotificationConfig(silent = false) {
  const payload = collectNotificationConfig();
  try {
    const res = await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Fejl');
    if (!silent) alert('Notifikationsindstillinger gemt!');
  } catch (err) {
    if (!silent) alert('Kunne ikke gemme notifikationsindstillinger');
  }
}

// --- Connection Testing ---
async function testConnection() {  const provider = settingsProvider.value;
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
