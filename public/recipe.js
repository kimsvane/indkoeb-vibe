/* ==========================================================
   PrisJagt - Recipe Scanning & Multi-ingredient UI Logic
   ========================================================== */

'use strict';

// --- State ---
let recipeIngredients = [];
let recipeResults = null;
let organicMode = false;

// --- DOM References ---
const tabSearchBtn = document.getElementById('tab-btn-search');
const tabRecipeBtn = document.getElementById('tab-btn-recipe');
const tabSearchContent = document.getElementById('tab-content-search');
const tabRecipeContent = document.getElementById('tab-content-recipe');

const recipeForm = document.getElementById('recipe-form');
const recipeUrlInput = document.getElementById('recipe-url-input');
const clearRecipeUrl = document.getElementById('clear-recipe-url');
const recipeSubmitBtn = document.getElementById('recipe-submit-btn');

const recipeStatusSection = document.getElementById('recipe-status-section');
const stepFetch = document.getElementById('step-fetch');
const stepExtract = document.getElementById('step-extract');
const stepSearch = document.getElementById('step-search');

const recipeResultsSection = document.getElementById('recipe-results-section');
const recipeTotalPrice = document.getElementById('recipe-total-price');
const recipeMatchedCount = document.getElementById('recipe-matched-count');
const recipeOrganicTotalPrice = document.getElementById('recipe-organic-total-price');
const recipeRecommendedStore = document.getElementById('recipe-recommended-store');
const recipeStoreCoverage = document.getElementById('recipe-store-coverage');
const recipeToggleOrganic = document.getElementById('recipe-toggle-organic');
const recipeCopyListBtn = document.getElementById('recipe-copy-list-btn');
const recipeIngredientsGrid = document.getElementById('recipe-ingredients-grid');

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  setupTabNavigation();
  setupRecipeListeners();
  // Re-render recipe results when location/distance changes
  if (window.onLocationChange) {
    window.onLocationChange(() => {
      if (recipeResults && !recipeResultsSection.classList.contains('hidden')) {
        // Genhent priser med den nye placering så afstande beregnes korrekt
        refreshRecipePrices();
      }
    });
  }
});

// --- Tab Navigation Setup ---
function setupTabNavigation() {
  const tabs = [
    { btn: tabSearchBtn, content: tabSearchContent },
    { btn: tabRecipeBtn, content: tabRecipeContent }
  ];

  tabs.forEach(tab => {
    tab.btn.addEventListener('click', () => {
      // If clicking disabled recipe tab, open settings modal instead
      if (tab.btn === tabRecipeBtn && tab.btn.classList.contains('ai-disabled')) {
        alert('Tilkobl venligst en AI via indstillingerne (⚙️) først for at aktivere opskrift-scanning.');
        document.getElementById('settings-toggle-btn').click();
        return;
      }

      // Switch active class on buttons
      tabs.forEach(t => t.btn.classList.remove('active'));
      tab.btn.classList.add('active');

      // Switch active class on panes
      tabs.forEach(t => t.content.classList.remove('active'));
      tab.content.classList.add('active');
    });
  });
}

// --- Recipe Listeners Setup ---
function setupRecipeListeners() {
  // Clear button for recipe input
  recipeUrlInput.addEventListener('input', () => {
    clearRecipeUrl.classList.toggle('visible', recipeUrlInput.value.length > 0);
  });

  clearRecipeUrl.addEventListener('click', () => {
    recipeUrlInput.value = '';
    clearRecipeUrl.classList.remove('visible');
    recipeUrlInput.focus();
  });

  // Recipe scan form submit
  recipeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = recipeUrlInput.value.trim();
    if (!url) return;

    await handleRecipeScan(url);
  });

  // Organic toggle
  recipeToggleOrganic.addEventListener('click', () => {
    organicMode = !organicMode;
    recipeToggleOrganic.dataset.active = organicMode ? 'true' : 'false';
    renderIngredientsGrid();
  });

  // Copy list button
  recipeCopyListBtn.addEventListener('click', copyShoppingListToClipboard);
}

// --- Scanning Flow ---
async function handleRecipeScan(url) {
  const aiConfig = window.getAIConfig();
  if (!aiConfig || !aiConfig.connected) {
    alert('AI er ikke tilkoblet. Klik på indstillinger (⚙️) og test forbindelsen.');
    return;
  }

  // Reset UI states
  recipeStatusSection.classList.remove('hidden');
  recipeResultsSection.classList.add('hidden');
  recipeSubmitBtn.disabled = true;
  
  resetSteps();
  setStepState(stepFetch, 'pending', '1. Henter opskriftside...');

  try {
    // 1. Scan and extract ingredients
    const payload = {
      url,
      provider: aiConfig.provider
    };

    if (aiConfig.provider === 'ollama') {
      payload.baseUrl = aiConfig.ollamaUrl;
      payload.model = aiConfig.ollamaModel;
    } else {
      payload.apiKey = aiConfig.apiKey;
      payload.model = aiConfig.model;
      payload.baseUrl = aiConfig.baseUrl; // For custom OpenAI-compatible endpoints
    }

    setStepState(stepFetch, 'active', '1. Henter opskriftside...');
    const scanRes = await fetch('/api/recipe/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!scanRes.ok) {
      const err = await scanRes.json().catch(() => ({}));
      throw new Error(err.error || `Fejl under hentning (Status: ${scanRes.status})`);
    }

    setStepState(stepFetch, 'success', '1. Opskriftside hentet!');
    setStepState(stepExtract, 'active', '2. Analyserer og udtrækker ingredienser med AI...');

    const scanData = await scanRes.json();
    recipeIngredients = scanData.ingredients || [];

    if (recipeIngredients.length === 0) {
      throw new Error("Kunne ikke finde eller udtrække nogen ingredienser fra siden.");
    }

    // 2. Fetch prices for ingredients
    setStepState(stepExtract, 'success', `2. ${recipeIngredients.length} ingredienser udtrukket!`);
    setStepState(stepSearch, 'active', `3. Søger priser på tværs af butikker...`);

    const priceRes = await fetch('/api/recipe/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPricePayload(recipeIngredients))
    });

    if (!priceRes.ok) {
      const err = await priceRes.json().catch(() => ({}));
      throw new Error(err.error || `Fejl under søgning (Status: ${priceRes.status})`);
    }

    setStepState(stepSearch, 'success', '3. Prissammenligning fuldført!');
    
    recipeResults = await priceRes.json();

    // 3. Render results
    setTimeout(() => {
      recipeStatusSection.classList.add('hidden');
      renderRecipeResults();
    }, 600);

  } catch (err) {
    console.error('Recipe scan error:', err);
    alert(err.message || 'Noget gik galt under opskrifthandlingen.');
    recipeStatusSection.classList.add('hidden');
  } finally {
    recipeSubmitBtn.disabled = false;
  }
}

// --- Step Progress Helpers ---
function resetSteps() {
  [stepFetch, stepExtract, stepSearch].forEach(step => {
    step.className = 'status-step';
  });
}

function buildPricePayload(ingredients) {
  const payload = { ingredients };
  const state = window.getLocationFilterState();
  if (state.location) {
    payload.lat = state.location.lat;
    payload.lon = state.location.lon;
  }
  return payload;
}

function setStepState(element, state, text) {
  element.className = `status-step ${state}`;
  if (text) {
    element.textContent = text;
  }
}

// --- Render Results ---
function getRecipeView() {
  if (!recipeResults) return null;

  const state = window.getLocationFilterState();
  const maxKm = state.maxKm;
  const loc = state.location;

  // No active distance filter -> show full results as-is
  if (maxKm == null || !loc) return recipeResults;

  const inRange = (r) => !r || r.source === 'nemlig' || (r.distanceKm != null && r.distanceKm <= maxKm);

  const ingredients = recipeResults.ingredients.map(item => {
    const alternatives = (item.alternatives || []).filter(inRange);
    const bestMatch = inRange(item.bestMatch) ? item.bestMatch : alternatives[0] || null;
    let organicOption = inRange(item.organicOption) ? item.organicOption : null;
    if (!organicOption) {
      organicOption = alternatives.find(r => r.isOrganic) || null;
    }
    return { ...item, bestMatch, organicOption, alternatives };
  });

  // Recompute summary based on in-range matches only
  let matchedCount = 0;
  const storeCount = {};
  ingredients.forEach(item => {
    if (item.bestMatch) {
      matchedCount++;
      const store = item.bestMatch.store;
      storeCount[store] = (storeCount[store] || 0) + 1;
    }
  });

  let recommendedStore = 'Ingen match';
  let maxMatches = 0;
  for (const [store, count] of Object.entries(storeCount)) {
    if (count > maxMatches) {
      maxMatches = count;
      recommendedStore = store;
    }
  }

  const totalEstimate = ingredients.reduce((acc, item) => acc + (item.bestMatch?.price || 0), 0);
  const organicTotalEstimate = ingredients.reduce((acc, item) => {
    const match = item.organicOption || item.bestMatch;
    return acc + (match?.price || 0);
  }, 0);

  return {
    ...recipeResults,
    ingredients,
    summary: {
      ...recipeResults.summary,
      totalEstimate: Math.round(totalEstimate * 100) / 100,
      organicTotalEstimate: Math.round(organicTotalEstimate * 100) / 100,
      matchedCount,
      recommendedStore,
      storeMatches: maxMatches
    }
  };
}

// Genhenter opskrift-priser med den aktuelle placering (så afstande beregnes
// korrekt når brugeren ændrer placering efter analysen).
async function refreshRecipePrices() {
  if (!recipeIngredients || recipeIngredients.length === 0) {
    renderRecipeResults();
    return;
  }
  try {
    const priceRes = await fetch('/api/recipe/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPricePayload(recipeIngredients))
    });
    if (!priceRes.ok) {
      renderRecipeResults();
      return;
    }
    recipeResults = await priceRes.json();
    renderRecipeResults();
  } catch {
    renderRecipeResults();
  }
}

function renderRecipeResults() {
  const view = getRecipeView();
  if (!view) return;

  const sum = view.summary;
  
  // Dashboard values
  recipeTotalPrice.textContent = formatPrice(sum.totalEstimate);
  recipeMatchedCount.textContent = `${sum.matchedCount} af ${sum.totalCount} fundet`;
  recipeOrganicTotalPrice.textContent = formatPrice(sum.organicTotalEstimate);
  recipeRecommendedStore.textContent = sum.recommendedStore;
  recipeStoreCoverage.textContent = `Dækker ${sum.storeMatches} ud af ${sum.totalCount} varer`;

  renderIngredientsGrid(view);
  recipeResultsSection.classList.remove('hidden');
}

function renderIngredientsGrid(view = getRecipeView()) {
  recipeIngredientsGrid.innerHTML = '';
  if (!view || !view.ingredients) return;

  view.ingredients.forEach(item => {
    // Choose item based on organic mode toggle
    const match = (organicMode && item.organicOption) ? item.organicOption : item.bestMatch;
    const isOrganicUsed = organicMode && item.organicOption;
    
    const card = document.createElement('div');
    card.className = `recipe-ingredient-card ${match ? '' : 'no-match'}`;

    if (!match) {
      card.innerHTML = `
        <div class="card-header">
          <span class="ingredient-name">${escapeHtml(item.ingredient)}</span>
          <span class="badge badge-error">Ingen match</span>
        </div>
        <div class="card-content">
          <p class="text-muted">Kunne ikke finde varen i butikkerne.</p>
        </div>
      `;
    } else {
      const priceDisplay = formatPrice(match.price);
      const originalPriceDisplay = match.originalPrice ? `<span class="price-original-recipe">Var ${formatPrice(match.originalPrice)}</span>` : '';
      
      let badges = '';
      if (match.isOffer) badges += `<span class="badge badge-offer">% Tilbud</span>`;
      if (match.isOrganic) badges += `<span class="badge badge-organic">🌿 Øko</span>`;
      if (isOrganicUsed) badges += `<span class="badge badge-cheapest">✓ Valgt</span>`;

      const brandSize = [match.brand, match.size].filter(Boolean).join(' · ');
      const distanceInfo = match.source === 'nemlig'
        ? `<span class="distance-chip delivery-chip">🛒 Levering</span>`
        : (match.distanceKm != null ? `<span class="distance-chip">📍 ${formatDistance(match.distanceKm)}</span>` : '');

      card.innerHTML = `
        <div class="card-header">
          <span class="ingredient-name">${escapeHtml(item.ingredient)}</span>
          <div class="badge-row-small">${badges}</div>
        </div>
        <div class="card-body-recipe">
          <div class="product-row">
            ${match.imageUrl ? `<img src="${match.imageUrl}" class="product-thumb" alt="${escapeHtml(match.name)}">` : `<div class="product-thumb-placeholder">Intet foto</div>`}
            <div class="product-details">
              <div class="product-store-recipe">${escapeHtml(match.store)}</div>
              <div class="product-title-recipe">${escapeHtml(match.name)}</div>
              ${brandSize ? `<div class="product-desc-recipe">${escapeHtml(brandSize)}</div>` : ''}
              ${distanceInfo}
            </div>
          </div>
        </div>
        <div class="card-footer-recipe">
          <div class="price-section-recipe">
            <span class="price-main-recipe ${match.isOffer ? 'text-offer' : ''}">${priceDisplay}</span>
            ${originalPriceDisplay}
          </div>
          ${match.pricePerUnit ? `<span class="price-unit-recipe">${formatPrice(match.pricePerUnit)} ${match.unitPriceLabel}</span>` : ''}
        </div>
      `;
    }
    
    recipeIngredientsGrid.appendChild(card);
  });
}

// --- Shopping List Formatting ---
function copyShoppingListToClipboard() {
  const view = getRecipeView();
  if (!view) return;

  const url = recipeUrlInput.value.trim();
  const sum = view.summary;
  
  let text = `🍽️ PRISJAGT INDKØBSLISTE\n`;
  text += `Opskrift: ${url}\n`;
  text += `Tilstand: ${organicMode ? 'Økologisk prioriteret 🌿' : 'Billigste prioriteret 💵'}\n`;
  text += `--------------------------------------------------\n\n`;

  view.ingredients.forEach(item => {
    const match = (organicMode && item.organicOption) ? item.organicOption : item.bestMatch;
    
    if (match) {
      const details = [match.brand, match.size].filter(Boolean).join(', ');
      const organicText = match.isOrganic ? ' (Øko)' : '';
      const offerText = match.isOffer ? ' (Tilbud!)' : '';
      text += `- [ ] ${item.ingredient.toUpperCase()}:\n`;
      text += `      Valgt: ${match.name}${organicText}${offerText}\n`;
      text += `      Butik: ${match.store} | Pris: ${formatPrice(match.price)} (${details})\n\n`;
    } else {
      text += `- [ ] [MANGLER MATCH] ${item.ingredient.toUpperCase()}: (Ingen varer fundet i butikkerne)\n\n`;
    }
  });

  text += `--------------------------------------------------\n`;
  text += `Estimeret total: ${formatPrice(organicMode ? sum.organicTotalEstimate : sum.totalEstimate)}\n`;
  text += `Anbefalet butik (flest matches): ${sum.recommendedStore} (${sum.storeMatches} ud af ${sum.totalCount} varer)\n`;
  text += `Ekstraheret via PrisJagt AI.`;

  navigator.clipboard.writeText(text).then(() => {
    alert('Indkøbslisten er kopieret til din udklipsholder!');
  }).catch(err => {
    console.error('Fejl ved kopiering:', err);
    alert('Kunne ikke kopiere listen automatisk. Se konsollen.');
  });
}

// --- Utilities ---
function formatPrice(price) {
  if (price === null || price === undefined) return '–';
  return price.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}

function formatDistance(km) {
  if (km == null) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toLocaleString('da-DK', { maximumFractionDigits: 1 })} km`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
