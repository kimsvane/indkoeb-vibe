/* ==========================================================
   PrisJagt - Recipe Scanning & Multi-ingredient UI Logic
   ========================================================== */

'use strict';

// --- State ---
let recipeIngredients = [];
let recipeResults = null;
let organicMode = false;
let offersOnly = true; // true = vis kun tilbudsvarer (default). false = vis alt, manuelt valg af butikker.
let selectedChains = null; // null = alle butikker (ON-mode) / ingen valgt (OFF-mode); ellers et Set af valgte butiksnavne
let availableChains = [];

// --- DOM References ---
const tabSearchBtn = document.getElementById('tab-btn-search');
const tabRecipeBtn = document.getElementById('tab-btn-recipe');
const tabTasksBtn = document.getElementById('tab-btn-tasks');
const tabSearchContent = document.getElementById('tab-content-search');
const tabRecipeContent = document.getElementById('tab-content-recipe');
const tabTasksContent = document.getElementById('tab-content-tasks');

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
    { btn: tabRecipeBtn, content: tabRecipeContent },
    { btn: tabTasksBtn, content: tabTasksContent }
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

  // Vis kun tilbudsvarer — default til. Når fravalgt fravælges alle butikker,
  // så brugeren manuelt vælger hvilke butikker der skal hentes priser fra.
  const recipeToggleOffers = document.getElementById('recipe-toggle-offers');
  if (recipeToggleOffers) {
    recipeToggleOffers.addEventListener('click', () => {
      offersOnly = !offersOnly;
      recipeToggleOffers.dataset.active = offersOnly ? 'true' : 'false';
      if (!offersOnly) {
        // Fravalgt: tøm butiksvalg (null = ingen valgt i OFF-mode) så brugeren selv vælger
        selectedChains = null;
      } else {
        // Valgt: vis alle butikker igen
        selectedChains = null;
      }
      updateChainButtonLabel();
      renderRecipeResults();
    });
  }

  // Copy list button
  recipeCopyListBtn.addEventListener('click', copyShoppingListToClipboard);

  // Chain multi-select filter
  const chainBtn = document.getElementById('chain-filter-btn');
  if (chainBtn) {
    chainBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleChainDropdown();
    });
  }
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('chain-dropdown');
    const btn = document.getElementById('chain-filter-btn');
    if (!dropdown || !btn) return;
    if (!dropdown.classList.contains('hidden') &&
        !dropdown.contains(e.target) && !btn.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
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
  const distanceActive = !(maxKm == null || !loc);
  const chainEmpty = !selectedChains || selectedChains.size === 0;

  const inRange = (r) =>
    !r ||
    r.source === 'nemlig' ||
    !distanceActive ||
    (r.distanceKm != null && r.distanceKm <= maxKm);

  // ON-mode (kun tilbud) + ingen butik valgt => alle butikker.
  // OFF-mode + ingen butik valgt => ingen (brugeren skal vælge manuelt).
  const inChain = (r) => {
    if (chainEmpty) return offersOnly;
    return selectedChains.has(r.store);
  };

  const ingredients = recipeResults.ingredients.map(item => {
    const candidates = [item.bestMatch, ...(item.alternatives || [])].filter(Boolean);
    const allowed = candidates.filter(r => (!offersOnly || r.isOffer) && inRange(r) && inChain(r));
    const match = allowed[0] || null;
    const organicOption = allowed.find(r => r.isOrganic) || null;
    const alternatives = allowed.slice(0, 5);
    return { ...item, bestMatch: match, organicOption, alternatives };
  });

  // Genberegn opsummering ud fra de tilladte matches
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

  populateChainFilter();
  renderIngredientsGrid(view);

  const note = document.getElementById('recipe-source-note');
  if (note) {
    if (recipeResults && recipeResults.shelfAtlasActive) {
      note.classList.add('hidden');
    } else {
      note.textContent = 'ℹ️ Fysiske butikker viser kun varer der er PÅ TILBUD (Tjek). For at se almindelige priser i fysiske butikker uanset tilbud, tilføj SHELFATLAS_API_KEY til din .env og genstart. Online-priser (nemlig.com) vises altid.';
      note.classList.remove('hidden');
    }
  }

  // Hint når "Vis kun tilbudsvarer" er fravalgt og ingen butik er valgt
  const hint = document.getElementById('recipe-offers-hint');
  if (hint) {
    if (!offersOnly && (!selectedChains || selectedChains.size === 0)) {
      hint.textContent = '🔘 Tilbudsfiltret er slået fra. Vælg én eller flere butikker i listen ovenfor for at se priser (både tilbud og almindelige priser, f.eks. nemlig.com).';
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  }

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

      const leftover = computeLeftover(item, match);
      let leftoverHtml = '';
      if (leftover) {
        const parts = [`📦 Pakke ${escapeHtml(leftover.packageText)}`];
        if (leftover.needText) parts.push(`brugt ${escapeHtml(leftover.needText)}`);
        let tail = '';
        if (leftover.leftoverText) tail = ` · til overs: <b>${escapeHtml(leftover.leftoverText)}</b>`;
        else if (leftover.note) tail = ` · <i>${escapeHtml(leftover.note)}</i>`;
        leftoverHtml = `<div class="leftover-chip">${parts.join(' · ')}${tail}</div>`;
      }

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
          ${leftoverHtml}
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
       const leftover = computeLeftover(item, match);
       const leftoverText = leftover
          ? (() => {
              const bits = [`Køb ${leftover.packageText}`];
              if (leftover.needText) bits.push(`brugt ${leftover.needText}`);
              if (leftover.leftoverText) bits.push(`til overs ${leftover.leftoverText}`);
              else if (leftover.note) bits.push(`(${leftover.note})`);
              return ` | ${bits.join(', ')}`;
            })()
          : '';
       text += `- [ ] ${item.ingredient.toUpperCase()}:\n`;
       text += `      Valgt: ${match.name}${organicText}${offerText}\n`;
       text += `      Butik: ${match.store} | Pris: ${formatPrice(match.price)} (${details})${leftoverText}\n\n`;
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

// --- Mængde / "til overs" hjælpere ---

// Parser en størrelsesstreng ("1 kg", "2 x 500 g", "1000 ml", "6 stk") til
// kanonisk { value, dimension } hvor dimension er 'mass' (g), 'volume' (ml)
// eller 'count' (stk). Returnerer null hvis ikke parses.
function parsePackageSize(str) {
  if (!str) return null;
  let s = String(str).toLowerCase().replace(',', '.').replace(/\s+/g, ' ').trim();

  // multiplikator f.eks. "2 x 500 g"
  const multMatch = s.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*/);
  if (multMatch) {
    s = s.slice(multMatch[0].length);
  }
  const multiplier = multMatch ? parseFloat(multMatch[1]) : 1;

  const unitMap = {
    'kg': { dim: 'mass', factor: 1000 },
    'g': { dim: 'mass', factor: 1 },
    'l': { dim: 'volume', factor: 1000 },
    'liter': { dim: 'volume', factor: 1000 },
    'dl': { dim: 'volume', factor: 100 },
    'cl': { dim: 'volume', factor: 10 },
    'ml': { dim: 'volume', factor: 1 },
    'stk': { dim: 'count', factor: 1 },
    'styks': { dim: 'count', factor: 1 }
  };

  const m = s.match(/(\d+(?:\.\d+)?)\s*(kg|g|l|liter|dl|cl|ml|stk|styks)\b/);
  if (!m) return null;
  const u = unitMap[m[2]];
  if (!u) return null;
  return { value: parseFloat(m[1]) * multiplier * u.factor, dimension: u.dim };
}

// Opskriftens nødvendige mængde (amount + unit) til kanonisk form.
function recipeQuantityToCanonical(amount, unit) {
  if (amount == null || !unit) return null;
  const unitMap = {
    'kg': ['mass', 1000], 'g': ['mass', 1],
    'l': ['volume', 1000], 'liter': ['volume', 1000],
    'dl': ['volume', 100], 'cl': ['volume', 10], 'ml': ['volume', 1],
    'stk': ['count', 1], 'styks': ['count', 1], 'fed': ['count', 1]
  };
  const u = unitMap[String(unit).toLowerCase()];
  if (!u) return null;
  return { value: Number(amount) * u[1], dimension: u[0] };
}

// Pæn formatering af en kanonisk værdi (bruges til pakkestørrelse).
function formatQuantity(value, dimension) {
  if (value == null) return '';
  if (dimension === 'mass') {
    return value >= 1000
      ? `${(value / 1000).toLocaleString('da-DK', { maximumFractionDigits: 2 })} kg`
      : `${Math.round(value)} g`;
  }
  if (dimension === 'volume') {
    return value >= 1000
      ? `${(value / 1000).toLocaleString('da-DK', { maximumFractionDigits: 2 })} l`
      : `${Math.round(value)} ml`;
  }
  if (dimension === 'count') {
    return `${Math.round(value)} stk`;
  }
  return String(value);
}

// Formatering af opskriftens nødvendige mængde med den oprindelige enhed
// (f.eks. "1 fed" i stedet for "1 stk").
function formatNeed(value, unit) {
  const u = String(unit || '').toLowerCase();
  if (u === 'g') return value >= 1000 ? `${(value / 1000).toLocaleString('da-DK', { maximumFractionDigits: 2 })} kg` : `${Math.round(value)} g`;
  if (u === 'kg') return `${value} kg`;
  if (u === 'ml') return value >= 1000 ? `${(value / 1000).toLocaleString('da-DK', { maximumFractionDigits: 2 })} l` : `${Math.round(value)} ml`;
  if (u === 'l') return `${value} l`;
  return `${Math.round(value)} ${u}`;
}

// Beregner hvor meget der er til overs når man køber den valgte pakke.
// Returnerer altid pakke + brugt; "til overs" kun når enhederne er direkte
// sammenlignelige. F.eks. opskrift "1 fed" vs pakke "1 hvidløg" (hel vare)
// vises ærligt uden et misvisende tal.
function computeLeftover(item, match) {
  if (!match || !match.size) return null;
  const pkg = parsePackageSize(match.size);
  if (!pkg) return null;
  const packageText = formatQuantity(pkg.value, pkg.dimension);

  if (item.amount == null || !item.unit) {
    return { packageText, needText: null, leftoverText: null, note: null };
  }
  const need = recipeQuantityToCanonical(item.amount, item.unit);
  if (!need) return { packageText, needText: null, leftoverText: null, note: null };
  const needText = formatNeed(need.value, item.unit);

  // Kun sammenlignelig ved samme dimension og kompatible count-enheder
  // ("stk" = hel vare; "fed" er en underenhed og sammenlignes ikke med "stk").
  const compatible = pkg.dimension === need.dimension &&
    !(pkg.dimension === 'count' && String(item.unit).toLowerCase() !== 'stk');
  if (compatible) {
    const leftover = pkg.value - need.value;
    return {
      packageText,
      needText,
      leftoverText: leftover >= 0 ? formatQuantity(leftover, pkg.dimension) : null,
      note: leftover < 0 ? 'køb mere' : null
    };
  }

  // Uforenelige enheder (f.eks. "1 fed" vs pakke "1 hvidløg" som hel vare)
  const note = String(item.unit).toLowerCase() === 'fed'
    ? 'købes som hel vare — flere fed i en hvidløg'
    : 'købt som hel vare';
  return { packageText, needText, leftoverText: null, note };
}

// --- Butiksfilter (multivalg) ---

function collectChains(results) {
  const set = new Set();
  (results.ingredients || []).forEach(item => {
    [item.bestMatch, ...(item.alternatives || []), item.organicOption].forEach(r => {
      if (r && r.store) set.add(r.store);
    });
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'da'));
}

function populateChainFilter() {
  if (!recipeResults) return;
  availableChains = collectChains(recipeResults);
  const dropdown = document.getElementById('chain-dropdown');
  if (!dropdown) return;
  dropdown.innerHTML = '';

  availableChains.forEach(chain => {
    const label = document.createElement('label');
    label.className = 'chain-option';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = chain;
    cb.checked = !selectedChains || selectedChains.has(chain);
    cb.addEventListener('change', onChainFilterChange);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + chain));
    dropdown.appendChild(label);
  });

  updateChainButtonLabel();
}

function updateChainButtonLabel() {
  const btn = document.getElementById('chain-filter-btn');
  if (!btn) return;
  const total = availableChains.length;
  const label = btn.querySelector('.chain-count');
  if (!label) return;
  if (!selectedChains) {
    label.textContent = offersOnly ? 'Alle butikker' : 'Vælg butikker';
  } else {
    const sel = selectedChains.size;
    label.textContent = sel === total ? 'Alle butikker' : `${sel} af ${total} butikker`;
  }
}

function onChainFilterChange() {
  const checkboxes = document.querySelectorAll('#chain-dropdown input[type="checkbox"]');
  const sel = new Set();
  checkboxes.forEach(cb => { if (cb.checked) sel.add(cb.value); });
  selectedChains = sel.size === 0 ? null : sel;
  updateChainButtonLabel();
  renderRecipeResults();
}

function toggleChainDropdown() {
  const dropdown = document.getElementById('chain-dropdown');
  if (dropdown) dropdown.classList.toggle('hidden');
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
