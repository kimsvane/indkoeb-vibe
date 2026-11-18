/* ==========================================================
   PrisJagt - Long shopping list search

   Pastes a long list, splits it into items (locally or with an
   optional LLM), asks clarifying questions when products are
   ambiguous and searches all items across stores. Works with
   and without a configured LLM.
   ========================================================== */

'use strict';

const EXAMPLE_LIST = `Hør frø, solsikke kerner 800 g
• Rugkerner 1 pk
• 2 ps 5 kg hvedemel
• 2 pk gær
• 1 kg grovvalsede havregryn
• 3 kg yoghurt eller skyr
• 14 liter mælk
• 1 glas marmelade
• 300 g friske bær
• 4 bananer
• Rosiner
• 45 æg
• 2 pakker bacon (ca. 300–400 g)
• 2 pakker morgenmadspølser (ca. 600 g)
• 500 g skæreost
• 1 pakke smør (500 g)
• 400 g røget laks
• 400 g rejer (drænet vægt)
• 3 spegepølser
• 9 avocadoer
• 500 g tomater
• 3 agurk
• Snack peberfrugter
• mayonnaise
• 2 citroner
• 3 kg færdiglavede gnocchi
• 1,6-2 kg passata (mosede tomater)
• 800 g frisk mozzarella
• 2 pk parmesan
• 14 hele hvidløg (ca. 8–10 fed)
• 2 pakker romaine
• 1 pakke rucola
• 1 pose pinjekerner (ca. 50 g)
• 1 kg ramen-nudler
• 6 stk (3 pakker) pak choi
• 400 g svampe
• 2 bundter forårsløg
• 2 lime
• 1 ps frosne majs
• Evt. frisk koriander
• FRUGT: æbler, clementiner, vindruer, andet
• 3 liter appelsinjuice
• 3 liter æblejuice
• Kaffebønner
• Øl`;

// --- State ---
let listItems = [];
let listResults = null;
let chosenOverrides = {}; // itemId -> product id
let originalQueries = {}; // itemId -> original searchQuery
let onlyUncertain = false;

// --- DOM ---
const listForm = document.getElementById('list-form');
const listInput = document.getElementById('list-input');
const listClearBtn = document.getElementById('list-clear-btn');
const listExampleBtn = document.getElementById('list-example-btn');
const listUseAi = document.getElementById('list-use-ai');
const listAiHint = document.getElementById('list-ai-hint');
const listCount = document.getElementById('list-count');
const listSubmitBtn = document.getElementById('list-submit-btn');

const listStatusSection = document.getElementById('list-status-section');
const listStepRead = document.getElementById('list-step-read');
const listStepParse = document.getElementById('list-step-parse');
const listStepSearch = document.getElementById('list-step-search');

const listParseInfo = document.getElementById('list-parse-info');
const listQuestionsSection = document.getElementById('list-questions-section');
const listResultsSection = document.getElementById('list-results-section');
const listResultsGrid = document.getElementById('list-results-grid');
const listTotalPrice = document.getElementById('list-total-price');
const listMatchedCount = document.getElementById('list-matched-count');
const listUncertainCount = document.getElementById('list-uncertain-count');
const listRecommendedStore = document.getElementById('list-recommended-store');
const listStoreCoverage = document.getElementById('list-store-coverage');
const listOnlyUncertain = document.getElementById('list-only-uncertain');
const listCopyBtn = document.getElementById('list-copy-btn');
const listSourceNote = document.getElementById('list-source-note');

document.addEventListener('DOMContentLoaded', () => {
  setupListListeners();
  updateAiOption();
  window.addEventListener('aiConfigChanged', updateAiOption);

  // Genberegn afstande hvis brugeren ændrer placering efter søgningen.
  if (window.onLocationChange) {
    window.onLocationChange(() => {
      if (listResults && listResultsSection && !listResultsSection.classList.contains('hidden')) {
        refreshAllPrices();
      }
    });
  }
});

function setupListListeners() {
  if (!listForm) return;

  listInput.addEventListener('input', () => {
    updateListCount();
    listClearBtn.classList.toggle('visible', listInput.value.length > 0);
  });

  listClearBtn.addEventListener('click', () => {
    listInput.value = '';
    listClearBtn.classList.remove('visible');
    updateListCount();
    listInput.focus();
  });

  listExampleBtn.addEventListener('click', () => {
    listInput.value = EXAMPLE_LIST;
    listClearBtn.classList.add('visible');
    updateListCount();
    listInput.focus();
  });

  listForm.addEventListener('submit', (e) => {
    e.preventDefault();
    handleListSubmit();
  });

  listOnlyUncertain.addEventListener('click', () => {
    onlyUncertain = !onlyUncertain;
    listOnlyUncertain.dataset.active = onlyUncertain ? 'true' : 'false';
    renderListResults();
  });

  listCopyBtn.addEventListener('click', copyListToClipboard);

  // Event delegation for alternative-valg, gen-søgning m.m.
  listResultsGrid.addEventListener('click', onResultsClick);
  listResultsGrid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('.list-query-input');
    if (!input) return;
    e.preventDefault();
    rerunSearch(input.dataset.itemId, input.value);
  });

  listQuestionsSection.addEventListener('click', async (e) => {
    const chip = e.target.closest('.variant-chip');
    if (chip) {
      await chooseVariant(chip.dataset.itemId, chip.dataset.query, chip.dataset.label);
      return;
    }
    const reset = e.target.closest('.variant-reset');
    if (reset) {
      await chooseVariant(reset.dataset.itemId, originalQueries[reset.dataset.itemId], null);
      return;
    }
    const askBtn = e.target.closest('.variant-ask-btn');
    if (askBtn) {
      const id = askBtn.dataset.itemId;
      const input = listQuestionsSection.querySelector(`.variant-input[data-item-id="${id}"]`);
      if (input && input.value.trim()) {
        await chooseVariant(id, input.value.trim(), input.value.trim());
      }
    }
  });

  updateListCount();
}

function updateListCount() {
  if (!listCount) return;
  const text = listInput.value.trim();
  if (!text) {
    listCount.textContent = '';
    return;
  }
  const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
  listCount.textContent = `${lines} linje${lines === 1 ? '' : 'r'} · mængder ignoreres`;
}

function updateAiOption() {
  if (!listUseAi) return;
  const cfg = window.getAIConfig && window.getAIConfig();
  if (cfg && cfg.connected) {
    listUseAi.disabled = false;
    listUseAi.checked = true;
    listAiHint.textContent = `AI tilkoblet (${prettyProvider(cfg.provider)}) — bruges til at forstå listen. Du kan slå det fra.`;
  } else {
    listUseAi.checked = false;
    listUseAi.disabled = true;
    listAiHint.textContent = 'Ingen AI tilkoblet — listen læses lokalt. Tilkobl AI i ⚙️ for bedre forståelse og opfølgende spørgsmål.';
  }
}

function prettyProvider(provider) {
  if (!provider) return 'ukendt';
  const names = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', deepseek: 'DeepSeek', mistral: 'Mistral', ollama: 'Ollama' };
  return names[provider] || provider.charAt(0).toUpperCase() + provider.slice(1);
}

// --- Main flow ---

async function handleListSubmit() {
  const text = listInput.value.trim();
  if (!text) return;

  const aiConfig = window.getAIConfig && window.getAIConfig();
  const useAI = !!(listUseAi.checked && aiConfig && aiConfig.connected);

  listStatusSection.classList.remove('hidden');
  listResultsSection.classList.add('hidden');
  listQuestionsSection.classList.add('hidden');
  listParseInfo.classList.add('hidden');
  listSubmitBtn.disabled = true;

  setStep(listStepRead, 'active', '1. Læser indkøbslisten...');
  setStep(listStepParse, 'pending', '2. Forstår varerne...');
  setStep(listStepSearch, 'pending', '3. Søger priser på tværs af butikker...');

  try {
    const payload = { text, useLLM: useAI };
    if (useAI) {
      payload.provider = aiConfig.provider;
      if (aiConfig.provider === 'ollama') {
        payload.baseUrl = aiConfig.ollamaUrl;
        payload.model = aiConfig.ollamaModel;
      } else {
        payload.apiKey = aiConfig.apiKey;
        payload.model = aiConfig.model;
        payload.baseUrl = aiConfig.baseUrl;
      }
    }

    const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
    setStep(listStepRead, 'success', `1. ${lines} linje${lines === 1 ? '' : 'r'} læst`);
    setStep(listStepParse, 'active', `2. Forstår varerne${useAI ? ' med AI' : ' lokalt'}...`);

    const parseRes = await fetch('/api/list/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const parseData = await parseRes.json().catch(() => ({}));
    if (!parseRes.ok) throw new Error(parseData.error || `Fejl ved læsning (${parseRes.status})`);

    listItems = parseData.items || [];
    if (!listItems.length) throw new Error('Kunne ikke finde nogen varer i listen.');

    chosenOverrides = {};
    originalQueries = {};
    listItems.forEach(item => { originalQueries[item.id] = item.searchQuery; });

    const usedAI = parseData.source === 'llm';
    setStep(listStepParse, 'success', `2. ${listItems.length} varer forstået (${usedAI ? 'AI' : 'lokal læsning'})`);
    renderParseInfo(parseData);
    renderQuestions();

    setStep(listStepSearch, 'active', `3. Søger priser på ${listItems.length} varer...`);
    await fetchAllPrices();
    setStep(listStepSearch, 'success', '3. Prissammenligning fuldført!');

    setTimeout(() => {
      listStatusSection.classList.add('hidden');
      renderListResults();
    }, 450);

  } catch (err) {
    console.error('List search error:', err);
    alert(err.message || 'Noget gik galt under søgningen.');
    listStatusSection.classList.add('hidden');
  } finally {
    listSubmitBtn.disabled = false;
  }
}

function setStep(element, state, text) {
  element.className = `status-step ${state}`;
  element.textContent = text;
}

function buildListPricePayload(items) {
  const payload = { items };
  const state = window.getLocationFilterState && window.getLocationFilterState();
  if (state && state.location) {
    payload.lat = state.location.lat;
    payload.lon = state.location.lon;
  }
  return payload;
}

async function fetchAllPrices() {
  const res = await fetch('/api/list/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildListPricePayload(listItems))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fejl ved prissøgning (${res.status})`);
  listResults = data;
}

async function refreshAllPrices() {
  try {
    await fetchAllPrices();
  } catch (err) {
    console.warn('Kunne ikke opdatere priser:', err);
  }
  renderListResults();
}

async function rerunSearch(itemId, newQuery) {
  if (!listResults || !newQuery) return;
  const idx = listResults.ingredients.findIndex(i => i.itemId === itemId);
  if (idx === -1) return;

  const item = listItems.find(i => i.id === itemId);
  if (item) item.searchQuery = newQuery;
  delete chosenOverrides[itemId];

  try {
    const res = await fetch('/api/list/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildListPricePayload([item || { name: newQuery, searchQuery: newQuery }]))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Søgning mislykkedes');
    listResults.ingredients[idx] = data.ingredients[0];
  } catch (err) {
    console.error('Gen-søgning mislykkedes:', err);
  }
  renderListResults();
  renderQuestions();
}

async function chooseVariant(itemId, query, label) {
  await rerunSearch(itemId, query);
  if (label) {
    const input = listQuestionsSection.querySelector(`.variant-input[data-item-id="${itemId}"]`);
    if (input) input.value = label;
  }
}

// --- Parse info & follow-up questions ---

function renderParseInfo(data) {
  if (!listParseInfo) return;
  const usedAI = data.source === 'llm';
  const preview = listItems.slice(0, 24).map(i => `<span class="list-chip">${escapeListHtml(i.name)}</span>`).join('');
  const more = listItems.length > 24 ? `<span class="list-chip">+${listItems.length - 24} flere</span>` : '';

  listParseInfo.innerHTML = `
    <div class="list-parse-card">
      <div class="list-parse-summary">
        <span class="list-parse-badge">${listItems.length} varer</span>
        <span>Læst ${usedAI ? 'med AI' : 'lokalt (uden AI)'} · mængder og pakningstyper er ignoreret</span>
      </div>
      <div class="list-item-chips">${preview}${more}</div>
      ${data.warning ? `<div class="list-warning">${escapeListHtml(data.warning)}</div>` : ''}
    </div>
  `;
  listParseInfo.classList.remove('hidden');
}

function renderQuestions() {
  if (!listQuestionsSection) return;
  const questions = listItems.filter(i => i.question || (i.alternatives && i.alternatives.length));

  if (!questions.length) {
    listQuestionsSection.innerHTML = '';
    listQuestionsSection.classList.add('hidden');
    return;
  }

  let html = `
    <div class="list-questions-card">
      <h3 class="subsection-title">Præciser usikre varer (valgfrit)</h3>
      <p class="list-questions-help">Nogle varenavn kan dække flere produkter. Vælg en variant for at søge præcis — eller spring over og se alle muligheder i resultaterne.</p>
  `;

  for (const item of questions) {
    const alts = item.alternatives || [];
    const chips = alts.map(alt => `
      <button type="button" class="variant-chip" data-active="${item.searchQuery === alt.searchQuery ? 'true' : 'false'}" data-item-id="${escapeListHtml(item.id)}" data-query="${escapeListHtml(alt.searchQuery)}" data-label="${escapeListHtml(alt.label)}">${escapeListHtml(alt.label)}</button>
    `).join('');

    html += `
      <div class="list-question-row">
        <div class="list-question-title">${escapeListHtml(item.name)}</div>
        <div class="list-question-text">${escapeListHtml(item.question || 'Hvilken variant mener du?')}</div>
        <div class="variant-chips">
          <button type="button" class="variant-reset" data-item-id="${escapeListHtml(item.id)}" data-active="${originalQueries[item.id] === item.searchQuery ? 'true' : 'false'}">Som skrevet</button>
          ${chips}
        </div>
        <div class="variant-custom">
          <input type="text" class="variant-input" data-item-id="${escapeListHtml(item.id)}" placeholder="Eller skriv din egen søgestreng...">
          <button type="button" class="mini-btn variant-ask-btn" data-item-id="${escapeListHtml(item.id)}">Søg</button>
        </div>
      </div>
    `;
  }

  html += '</div>';
  listQuestionsSection.innerHTML = html;
  listQuestionsSection.classList.remove('hidden');
}

// --- Results ---

function getChosenMatch(item) {
  const overrideId = chosenOverrides[item.itemId];
  if (overrideId) {
    const found = (item.alternatives || []).find(r => r.id === overrideId);
    if (found) return found;
  }
  return item.bestMatch;
}

function renderListResults() {
  if (!listResults) return;

  const all = listResults.ingredients || [];
  const view = onlyUncertain ? all.filter(i => i.uncertain || chosenOverrides[i.itemId]) : all;

  const chosen = all.map(getChosenMatch).filter(Boolean);
  const total = chosen.reduce((sum, r) => sum + (r.price || 0), 0);
  const matchedCount = chosen.length;
  const storeCount = {};
  chosen.forEach(r => { storeCount[r.store] = (storeCount[r.store] || 0) + 1; });

  let recommended = 'Ingen match';
  let maxMatches = 0;
  for (const [store, count] of Object.entries(storeCount)) {
    if (count > maxMatches) { maxMatches = count; recommended = store; }
  }

  listTotalPrice.textContent = formatListPrice(Math.round(total * 100) / 100);
  listMatchedCount.textContent = `${matchedCount} af ${all.length} varer fundet`;
  listUncertainCount.textContent = String(all.filter(i => i.uncertain).length);
  listRecommendedStore.textContent = recommended;
  listStoreCoverage.textContent = `Dækker ${maxMatches} ud af ${all.length} varer`;

  if (listSourceNote) {
    if (listResults.shelfAtlasActive) {
      listSourceNote.classList.add('hidden');
    } else {
      listSourceNote.textContent = 'ℹ️ Fysiske butikker viser kun varer, der er på tilbud (Tjek). Online-priser (nemlig.com) vises altid. Tilføj SHELFATLAS_API_KEY til .env for almindelige hyldepriser.';
      listSourceNote.classList.remove('hidden');
    }
  }

  listResultsGrid.innerHTML = view.map(renderItemCard).join('') ||
    '<div class="empty-state"><h2>Ingen usikre varer</h2><p>Alle varer har et sikkert match. Slå filteret fra for at se hele listen.</p></div>';

  listResultsSection.classList.remove('hidden');
}

function renderItemCard(item) {
  const match = getChosenMatch(item);
  const confidenceLabel = item.confidence === 'high' ? '✓ Godt match'
    : item.confidence === 'medium' ? '~ Muligt match' : '? Usikker';
  const confidenceClass = item.confidence === 'high' ? 'confidence-high'
    : item.confidence === 'medium' ? 'confidence-medium' : 'confidence-low';

  let badges = `<span class="list-confidence ${confidenceClass}">${confidenceLabel}</span>`;
  if (chosenOverrides[item.itemId]) badges += `<span class="badge badge-cheapest">✓ Valgt af dig</span>`;
  if (match && match.isOffer) badges += `<span class="badge badge-offer">% Tilbud</span>`;
  if (match && match.isOrganic) badges += `<span class="badge badge-organic">🌿 Øko</span>`;

  const noteHtml = item.note ? `<div class="list-item-note">${escapeListHtml(item.note)}</div>` : '';

  if (!match) {
    return `
      <div class="recipe-ingredient-card no-match">
        <div class="card-header">
          <span class="ingredient-name">${escapeListHtml(item.ingredient)}</span>
          <div class="badge-row-small">${badges}</div>
        </div>
        <div class="card-content">
          ${noteHtml}
          <p class="text-muted">Ingen vare fundet. Prøv en kortere søgestreng:</p>
          <div class="list-query-editor">
            <input type="text" class="list-query-input" data-item-id="${escapeListHtml(item.itemId)}" value="${escapeListHtml(item.searchQuery)}">
            <button type="button" class="mini-btn list-rerun-btn" data-item-id="${escapeListHtml(item.itemId)}">Søg</button>
          </div>
        </div>
      </div>
    `;
  }

  const brandSize = [match.brand, match.size].filter(Boolean).join(' · ');
  const distanceInfo = match.source === 'nemlig'
    ? `<span class="distance-chip delivery-chip">🛒 Levering</span>`
    : (match.distanceKm != null ? `<span class="distance-chip">📍 ${formatListDistance(match.distanceKm)}</span>` : '');
  const originalPrice = match.originalPrice
    ? `<span class="price-original-recipe">Var ${formatListPrice(match.originalPrice)}</span>` : '';

  const alts = (item.alternatives || []).filter(r => r.id !== match.id).slice(0, 5);
  const altHtml = alts.length ? `
    <details class="list-alternatives">
      <summary>Alternativer (${alts.length})</summary>
      <div class="list-alt-list">
        ${alts.map(a => `
          <div class="list-alt-row">
            <div class="list-alt-info">
              <span class="list-alt-store">${escapeListHtml(a.store)}</span>
              <span class="list-alt-name">${escapeListHtml(a.name)}${a.brand ? ` · ${escapeListHtml(a.brand)}` : ''}</span>
              ${a.size ? `<span class="list-alt-size">${escapeListHtml(a.size)}</span>` : ''}
            </div>
            <button type="button" class="list-alt-btn" data-item-id="${escapeListHtml(item.itemId)}" data-product-id="${escapeListHtml(a.id)}">${formatListPrice(a.price)} · Vælg</button>
          </div>
        `).join('')}
      </div>
      ${chosenOverrides[item.itemId] ? `<button type="button" class="link-btn list-use-best-btn" data-item-id="${escapeListHtml(item.itemId)}">Gå tilbage til bedste match</button>` : ''}
    </details>
  ` : '';

  return `
    <div class="recipe-ingredient-card">
      <div class="card-header">
        <span class="ingredient-name">${escapeListHtml(item.ingredient)}</span>
        <div class="badge-row-small">${badges}</div>
      </div>
      <div class="card-body-recipe">
        ${noteHtml}
        <div class="product-row">
          ${match.imageUrl ? `<img src="${match.imageUrl}" class="product-thumb" alt="${escapeListHtml(match.name)}">` : `<div class="product-thumb-placeholder">Intet foto</div>`}
          <div class="product-details">
            <div class="product-store-recipe">${escapeListHtml(match.store)}</div>
            <div class="product-title-recipe">${escapeListHtml(match.name)}</div>
            ${brandSize ? `<div class="product-desc-recipe">${escapeListHtml(brandSize)}</div>` : ''}
            ${distanceInfo}
          </div>
        </div>
        ${altHtml}
        <div class="list-query-editor hidden">
          <input type="text" class="list-query-input" data-item-id="${escapeListHtml(item.itemId)}" value="${escapeListHtml(item.searchQuery)}">
          <button type="button" class="mini-btn list-rerun-btn" data-item-id="${escapeListHtml(item.itemId)}">Søg</button>
        </div>
        <button type="button" class="link-btn list-edit-btn" data-item-id="${escapeListHtml(item.itemId)}">✏️ Ændr søgning</button>
      </div>
      <div class="card-footer-recipe">
        <div class="price-section-recipe">
          <span class="price-main-recipe ${match.isOffer ? 'text-offer' : ''}">${formatListPrice(match.price)}</span>
          ${originalPrice}
        </div>
        ${match.pricePerUnit ? `<span class="price-unit-recipe">${formatListPrice(match.pricePerUnit)} ${escapeListHtml(match.unitPriceLabel || '')}</span>` : ''}
      </div>
    </div>
  `;
}

function onResultsClick(e) {
  const altBtn = e.target.closest('.list-alt-btn');
  if (altBtn) {
    chosenOverrides[altBtn.dataset.itemId] = altBtn.dataset.productId;
    renderListResults();
    return;
  }

  const bestBtn = e.target.closest('.list-use-best-btn');
  if (bestBtn) {
    delete chosenOverrides[bestBtn.dataset.itemId];
    renderListResults();
    return;
  }

  const editBtn = e.target.closest('.list-edit-btn');
  if (editBtn) {
    const editor = editBtn.parentElement.querySelector('.list-query-editor');
    if (editor) {
      editor.classList.toggle('hidden');
      const input = editor.querySelector('input');
      if (input && !editor.classList.contains('hidden')) input.focus();
    }
    return;
  }

  const rerunBtn = e.target.closest('.list-rerun-btn');
  if (rerunBtn) {
    const input = rerunBtn.parentElement.querySelector('.list-query-input');
    if (input) rerunSearch(rerunBtn.dataset.itemId, input.value.trim());
  }
}

// --- Copy shopping list ---

function copyListToClipboard() {
  if (!listResults) return;
  const chosen = listResults.ingredients.map(item => ({ item, match: getChosenMatch(item) }));

  let text = '🛒 PRISJAGT INDKØBSLISTE\n';
  text += `Varer: ${chosen.length}\n`;
  text += '--------------------------------------------------\n\n';
  for (const { item, match } of chosen) {
    if (match) {
      const details = [match.brand, match.size].filter(Boolean).join(', ');
      text += `- [ ] ${item.ingredient}: ${match.name}${details ? ` (${details})` : ''} — ${match.store}, ${formatListPrice(match.price)}${match.isOffer ? ' (Tilbud!)' : ''}\n`;
    } else {
      text += `- [ ] ${item.ingredient}: [INGEN MATCH]\n`;
    }
  }
  text += '--------------------------------------------------\n';
  text += `Estimeret total: ${formatListPrice(Math.round(chosen.reduce((s, c) => s + (c.match?.price || 0), 0) * 100) / 100)}\n`;

  navigator.clipboard.writeText(text).then(() => {
    alert('Indkøbslisten er kopieret til din udklipsholder!');
  }).catch(() => {
    alert('Kunne ikke kopiere listen automatisk. Se konsollen.');
  });
}

// --- Helpers ---

function formatListPrice(price) {
  if (price === null || price === undefined) return '–';
  return price.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}

function formatListDistance(km) {
  if (km == null) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toLocaleString('da-DK', { maximumFractionDigits: 1 })} km`;
}

function escapeListHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
