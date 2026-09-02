/* ==========================================================
   PrisJagt - Vareovervågning (Scheduled Task Watcher)
   ========================================================= */

'use strict';

// --- State ---
let watchedTasks = [];
let availableChains = [];

// --- DOM References ---
const taskForm = document.getElementById('task-form');
const taskQueryInput = document.getElementById('task-query-input');
const taskFrequency = document.getElementById('task-frequency');
const taskList = document.getElementById('task-list');
const taskEmptyState = document.getElementById('task-empty-state');
const taskRunAllBtn = document.getElementById('task-run-all-btn');
const taskStatus = document.getElementById('task-status');
const taskChainsList = document.getElementById('task-chains-list');
const taskChainsToggleAll = document.getElementById('task-chains-toggle-all');

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  setupTaskListeners();
  await loadChains();
  loadTasks();
});

async function loadChains() {
  try {
    const res = await fetch('/api/tasks/chains');
    if (!res.ok) throw new Error('Fejl');
    const data = await res.json();
    availableChains = data.chains || [];
    renderChainCheckboxes();
  } catch (err) {
    console.error('[Tasks] Kunne ikke hente butikker:', err.message);
  }
}

function renderChainCheckboxes() {
  if (!taskChainsList) return;
  taskChainsList.innerHTML = '';
  availableChains.forEach(chain => {
    const label = document.createElement('label');
    label.className = 'task-chain-item';
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(chain)}" class="task-chain-checkbox"> ${escapeHtml(chain)}`;
    taskChainsList.appendChild(label);
  });
}

function getSelectedChains() {
  if (!taskChainsList) return [];
  return Array.from(taskChainsList.querySelectorAll('.task-chain-checkbox:checked')).map(cb => cb.value);
}

function setupTaskListeners() {
  if (taskForm) {
    taskForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const query = taskQueryInput.value.trim();
      if (!query) return;
      const frequency = taskFrequency.value;
      const chains = getSelectedChains();
      await addTask(query, frequency, chains);
      taskQueryInput.value = '';
    });
  }

  if (taskRunAllBtn) {
    taskRunAllBtn.addEventListener('click', runAllTasks);
  }

  if (taskChainsToggleAll) {
    taskChainsToggleAll.addEventListener('click', () => {
      const checkboxes = taskChainsList.querySelectorAll('.task-chain-checkbox');
      const allChecked = Array.from(checkboxes).every(cb => cb.checked);
      checkboxes.forEach(cb => { cb.checked = !allChecked; });
      taskChainsToggleAll.textContent = allChecked ? 'Vælg alle' : 'Fravælg alle';
    });
  }
}

// --- API Helpers ---
async function loadTasks() {
  try {
    const res = await fetch('/api/tasks');
    if (!res.ok) throw new Error('Fejl');
    const data = await res.json();
    watchedTasks = data.tasks || [];
    renderTaskList();
  } catch (err) {
    console.error('[Tasks] Kunne ikke hente opgaver:', err.message);
  }
}

async function addTask(query, frequency, chains = []) {
  try {
    showTaskStatus('Tilføjer...');
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, frequency, chains })
    });
    if (!res.ok) throw new Error('Fejl');
    const task = await res.json();
    watchedTasks.push(task);
    renderTaskList();
    showTaskStatus('');
  } catch (err) {
    showTaskStatus('Kunne ikke tilføje opgave');
  }
}

async function deleteTask(id) {
  try {
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    watchedTasks = watchedTasks.filter(t => t.id !== id);
    renderTaskList();
  } catch (err) {
    console.error('[Tasks] Sletning fejlede:', err.message);
  }
}

async function toggleTask(id) {
  try {
    const res = await fetch(`/api/tasks/${id}/toggle`, { method: 'POST' });
    if (!res.ok) throw new Error('Fejl');
    const updated = await res.json();
    const idx = watchedTasks.findIndex(t => t.id === id);
    if (idx !== -1) watchedTasks[idx] = updated;
    renderTaskList();
  } catch (err) {
    console.error('[Tasks] Toggle fejlede:', err.message);
  }
}

async function runSingleTask(id) {
  try {
    showTaskStatus('Søger...');
    taskRunAllBtn && (taskRunAllBtn.disabled = true);
    const res = await fetch('/api/tasks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) throw new Error('Fejl');
    const updated = await res.json();
    const idx = watchedTasks.findIndex(t => t.id === id);
    if (idx !== -1) watchedTasks[idx] = updated;
    renderTaskList();
    showTaskStatus('');
  } catch (err) {
    showTaskStatus('Søgning fejlede');
  } finally {
    taskRunAllBtn && (taskRunAllBtn.disabled = false);
  }
}

async function runAllTasks() {
  try {
    showTaskStatus('Søger alle...');
    taskRunAllBtn.disabled = true;
    const res = await fetch('/api/tasks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error('Fejl');
    await loadTasks();
    showTaskStatus('');
  } catch (err) {
    showTaskStatus('Søgning fejlede');
  } finally {
    taskRunAllBtn.disabled = false;
  }
}

// --- Rendering ---
function renderTaskList() {
  if (!taskList) return;
  taskList.innerHTML = '';

  if (watchedTasks.length === 0) {
    if (taskEmptyState) taskEmptyState.classList.remove('hidden');
    return;
  }
  if (taskEmptyState) taskEmptyState.classList.add('hidden');

  watchedTasks.forEach(task => {
    const card = document.createElement('div');
    card.className = `task-card ${task.enabled ? '' : 'task-disabled'}`;

    const freqLabel = { daily: 'Dagligt', 'twice-weekly': '2 gange/uge', weekly: 'Ugentligt' }[task.frequency] || task.frequency;
    const chainsLabel = task.chains?.length > 0 ? task.chains.join(', ') : 'Alle butikker';

    let statusLine = '';
    if (task.lastChecked) {
      const ago = timeAgo(new Date(task.lastChecked));
      statusLine = `Sidst tjekket: ${ago}`;
      if (task.bestPrice != null) {
        statusLine += ` — Bedste: ${formatPrice(task.bestPrice)} i ${escapeHtml(task.bestStore || '')}`;
      }
    } else {
      statusLine = 'Ikke søgt endnu';
    }

    card.innerHTML = `
      <div class="task-card-header">
        <div class="task-info">
          <span class="task-query">${escapeHtml(task.query)}</span>
          <span class="task-freq">${freqLabel}</span>
        </div>
        <div class="task-actions">
          <button class="task-btn task-run-btn" data-id="${task.id}" title="Søg nu">🔍</button>
          <button class="task-btn task-toggle-btn" data-id="${task.id}" title="${task.enabled ? 'Deaktiver' : 'Aktiver'}">
            ${task.enabled ? '⏸' : '▶️'}
          </button>
          <button class="task-btn task-delete-btn" data-id="${task.id}" title="Slet">✕</button>
        </div>
      </div>
      <div class="task-card-chains">${escapeHtml(chainsLabel)}</div>
      <div class="task-card-status">${statusLine}</div>
    `;

    taskList.appendChild(card);
  });

  // Attach event listeners
  taskList.querySelectorAll('.task-run-btn').forEach(btn => {
    btn.addEventListener('click', () => runSingleTask(btn.dataset.id));
  });
  taskList.querySelectorAll('.task-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleTask(btn.dataset.id));
  });
  taskList.querySelectorAll('.task-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (confirm('Slet denne overvågning?')) deleteTask(btn.dataset.id);
    });
  });
}

// --- Utilities ---
function formatPrice(price) {
  if (price == null) return '–';
  return price.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'lige nu';
  if (mins < 60) return `${mins} min siden`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} t siden`;
  const days = Math.floor(hours / 24);
  return `${days} d siden`;
}

function showTaskStatus(msg) {
  if (taskStatus) {
    taskStatus.textContent = msg;
    taskStatus.classList.toggle('hidden', !msg);
  }
}
