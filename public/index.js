/* ==========================================================
   PrisJagt - Frontend Application Logic
   ========================================================== */

'use strict';

// --- State ---
let allResults = [];
let filteredResults = [];
let currentQuery = '';

// --- DOM References ---
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const clearButton = document.getElementById('clear-search');
const loadingState = document.getElementById('loading-state');
const resultsGrid = document.getElementById('results-grid');
const controlsSection = document.getElementById('controls-section');
const statsSection = document.getElementById('stats-section');
const toggleOrganic = document.getElementById('toggle-organic');
const toggleOffer = document.getElementById('toggle-offer');
const storeSelect = document.getElementById('store-select');
const categorySelect = document.getElementById('category-select');
const sortSelect = document.getElementById('sort-select');
const distanceSelect = document.getElementById('distance-select');
const locateBtn = document.getElementById('locate-btn');
const postalInput = document.getElementById('postal-input');
const postalApplyBtn = document.getElementById('postal-apply-btn');
const locationStatus = document.getElementById('location-status');

// --- Location state ---
let userLocation = null; // { lat, lon, label }
let maxDistanceKm = null; // number or null
let locationResolvers = [];

// Expose shared state to recipe.js and other modules
function getLocationFilterState() {
  return {
    location: userLocation,
    maxKm: maxDistanceKm,
    distanceActive: maxDistanceKm != null
  };
}
window.getLocationFilterState = getLocationFilterState;

// --- Quick Search Chips ---
document.querySelectorAll('.search-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    searchInput.value = chip.textContent;
    handleSearch();
  });
});

// --- Clear Button ---
searchInput.addEventListener('input', () => {
  clearButton.classList.toggle('visible', searchInput.value.length > 0);
});

clearButton.addEventListener('click', () => {
  searchInput.value = '';
  clearButton.classList.remove('visible');
  searchInput.focus();
});

// --- Search Form Submit ---
searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  handleSearch();
});

// --- Filter & Sort listeners ---
toggleOrganic.addEventListener('click', () => toggleFilter(toggleOrganic));
toggleOffer.addEventListener('click', () => toggleFilter(toggleOffer));
storeSelect.addEventListener('change', applyFiltersAndSort);
categorySelect.addEventListener('change', applyFiltersAndSort);
sortSelect.addEventListener('change', applyFiltersAndSort);
distanceSelect.addEventListener('change', onDistanceChange);
locateBtn.addEventListener('click', onLocateClick);
postalApplyBtn.addEventListener('click', applyPostalCode);
postalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyPostalCode();
  }
});

function onDistanceChange() {
  const raw = distanceSelect.value;
  maxDistanceKm = raw === 'all' ? null : parseFloat(raw);
  if (maxDistanceKm != null && !userLocation) {
    setLocationStatus('Vælg en placering (📍 eller postnummer) for at filtrere på afstand.', 'warn');
    applyFiltersAndSort();
    notifyLocationChange();
    return;
  }
  setLocationStatus(userLocation ? `Viser kun butikker inden for ${maxDistanceKm} km af ${userLocation.label}` : '');
  applyFiltersAndSort();
  notifyLocationChange();
}

function notifyLocationChange() {
  locationResolvers.forEach(cb => cb());
}

window.onLocationChange = (cb) => {
  locationResolvers.push(cb);
};

async function onLocateClick() {
  if (!navigator.geolocation) {
    setLocationStatus('Geolocation understøttes ikke. Indtast postnummer i stedet.', 'warn');
    return;
  }
  setLocationStatus('Finder din placering...', 'busy');
  locateBtn.disabled = true;
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 300000
      });
    });
    userLocation = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      label: 'din placering'
    };
    locateBtn.dataset.active = 'true';
    setLocationStatus(`Placering sat. Nærmeste butikker inden for ${maxDistanceKm != null ? maxDistanceKm + ' km' : 'valgt afstand'}.`);
    if (currentQuery) refreshSearch();
    else { applyFiltersAndSort(); notifyLocationChange(); }
  } catch (err) {
    setLocationStatus('Kunne ikke finde din placering. Indtast postnummer i stedet.', 'warn');
  } finally {
    locateBtn.disabled = false;
  }
}

async function applyPostalCode() {
  const nr = postalInput.value.trim();
  if (!/^\d{4}$/.test(nr)) {
    setLocationStatus('Indtast et gyldigt 4-cifret postnummer.', 'warn');
    return;
  }
  setLocationStatus('Slår postnummer op...', 'busy');
  try {
    const res = await fetch(`https://api.dataforsyningen.dk/postnumre/${nr}`);
    if (!res.ok) throw new Error('Ugyldigt postnummer');
    const data = await res.json();
    let lon, lat;
    if (Array.isArray(data.visueltcenter)) {
      [lon, lat] = data.visueltcenter;
    } else if (Array.isArray(data.bbox)) {
      const [x1, y1, x2, y2] = data.bbox;
      lon = x1 + (x2 - x1) / 2;
      lat = y1 + (y2 - y1) / 2;
    }
    if (lat == null || lon == null) throw new Error('Ingen koordinater');
    userLocation = { lat, lon, label: `${data.navn} (${nr})` };
    locateBtn.dataset.active = 'true';
    setLocationStatus(`Placering sat: ${userLocation.label}.`);
    if (currentQuery) refreshSearch();
    else { applyFiltersAndSort(); notifyLocationChange(); }
  } catch (err) {
    setLocationStatus('Kunne ikke finde postnummeret. Prøv igen.', 'warn');
  }
}

function setLocationStatus(text, state = '') {
  locationStatus.textContent = text;
  locationStatus.className = 'location-status';
  if (state) locationStatus.classList.add(state);
}

// --- Keyboard Shortcut: Cmd/Ctrl+K to focus search ---
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// ============================================================
// CORE LOGIC
// ============================================================

async function handleSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  currentQuery = query;
  allResults = [];
  filteredResults = [];

  showLoading();

  try {
    let url = `/api/search?q=${encodeURIComponent(query)}`;
    if (userLocation) {
      url += `&lat=${userLocation.lat}&lon=${userLocation.lon}`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Server fejl: ${res.status}`);
    const data = await res.json();

    allResults = data.results || [];
    
    // Populate store filter
    populateStoreFilter(allResults);
    // Populate category filter from API-provided list
    populateCategoryFilter(data.categories || []);
    
    // Apply initial filters/sort
    applyFiltersAndSort();

    // Show controls
    controlsSection.classList.remove('hidden');

  } catch (err) {
    console.error('Search error:', err);
    showError(err.message);
  }
}

// Genhenter søgningen med den aktuelle placering, så afstande (distanceKm)
// beregnes på serveren. Kaldes når brugerens placering ændres.
function refreshSearch() {
  if (!currentQuery) return;
  handleSearch();
}

function toggleFilter(btn) {
  const currentlyActive = btn.dataset.active === 'true';
  btn.dataset.active = currentlyActive ? 'false' : 'true';
  applyFiltersAndSort();
}

function applyFiltersAndSort() {
  const organicOnly = toggleOrganic.dataset.active === 'true';
  const offerOnly = toggleOffer.dataset.active === 'true';
  const selectedStore = storeSelect.value;
  const selectedCategory = categorySelect.value;
  const sortMode = sortSelect.value;

  let results = [...allResults];

  // Filter: Organic
  if (organicOnly) {
    results = results.filter(item => item.isOrganic);
  }

  // Filter: Offers only
  if (offerOnly) {
    results = results.filter(item => item.isOffer);
  }

  // Filter: Store
  if (selectedStore !== 'all') {
    results = results.filter(item => item.store === selectedStore);
  }

  // Filter: Category
  if (selectedCategory !== 'all') {
    results = results.filter(item => item.category === selectedCategory);
  }

  // Filter: Distance (max km from user location)
  if (maxDistanceKm != null && userLocation) {
    results = results.filter(item => {
      // nemlig.com leverer - altid inden for afstand
      if (item.source === 'nemlig') return true;
      return item.distanceKm != null && item.distanceKm <= maxDistanceKm;
    });
  }

  // Sort
  if (sortMode === 'unitprice-asc') {
    results.sort((a, b) => {
      const aU = a.pricePerUnit ?? Infinity;
      const bU = b.pricePerUnit ?? Infinity;
      return aU - bU;
    });
  } else if (sortMode === 'distance-asc') {
    results.sort((a, b) => {
      const aD = a.source === 'nemlig' ? 0 : (a.distanceKm ?? Infinity);
      const bD = b.source === 'nemlig' ? 0 : (b.distanceKm ?? Infinity);
      if (aD !== bD) return aD - bD;
      if (a.price === null) return 1;
      if (b.price === null) return -1;
      return a.price - b.price;
    });
  } else {
    // Default: price-asc
    results.sort((a, b) => {
      if (a.price === null) return 1;
      if (b.price === null) return -1;
      return a.price - b.price;
    });
  }

  filteredResults = results;
  renderStats(filteredResults);
  renderResults(filteredResults);
}

// ============================================================
// RENDERING
// ============================================================

function showLoading() {
  hideAll();
  loadingState.classList.remove('hidden');
  controlsSection.classList.add('hidden');
  statsSection.classList.add('hidden');
  statsSection.innerHTML = '';
}

function hideAll() {
  loadingState.classList.add('hidden');
  resultsGrid.innerHTML = '';
}

function showError(message) {
  hideAll();
  resultsGrid.innerHTML = `
    <div class="error-state">
      <h3>Noget gik galt 😕</h3>
      <p>${message || 'Prøv igen om lidt.'}</p>
    </div>
  `;
}

function populateStoreFilter(results) {
  const stores = [...new Set(results.map(r => r.store))].sort();
  storeSelect.innerHTML = '<option value="all">Alle butikker</option>';
  stores.forEach(store => {
    const opt = document.createElement('option');
    opt.value = store;
    opt.textContent = store;
    storeSelect.appendChild(opt);
  });
}

function populateCategoryFilter(categories) {
  // Keep previously selected value if it still exists
  const prev = categorySelect.value;
  categorySelect.innerHTML = '<option value="all">Alle kategorier</option>';
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (cat === prev) opt.selected = true;
    categorySelect.appendChild(opt);
  });
}

function renderStats(results) {
  statsSection.innerHTML = '';
  if (results.length === 0) {
    statsSection.classList.add('hidden');
    return;
  }

  const total = results.length;
  const withPrice = results.filter(r => r.price !== null);
  const cheapest = withPrice.length > 0 ? withPrice[0] : null;
  const organicCount = results.filter(r => r.isOrganic).length;
  const offerCount = results.filter(r => r.isOffer).length;
  const storeCount = new Set(results.map(r => r.store)).size;

  const statsData = [
    { label: 'Resultater fundet', value: `${total}`, sub: `fra ${storeCount} butikker` },
    cheapest
      ? { label: 'Billigste pris', value: formatPrice(cheapest.price), sub: cheapest.store + ' – ' + (cheapest.name.length > 22 ? cheapest.name.slice(0, 22) + '…' : cheapest.name) }
      : null,
    { label: 'Tilbud / Kampagner', value: `${offerCount}`, sub: 'aktive tilbud i søgningen' },
    organicCount > 0 ? { label: 'Økologiske varer', value: `${organicCount}`, sub: 'mærkede med Øko' } : null,
  ].filter(Boolean);

  statsData.forEach(stat => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    card.innerHTML = `
      <div class="stat-label">${stat.label}</div>
      <div class="stat-value">${stat.value}</div>
      <div class="stat-sub">${stat.sub}</div>
    `;
    statsSection.appendChild(card);
  });

  statsSection.classList.remove('hidden');
}

function renderResults(results) {
  hideAll();

  if (results.length === 0) {
    resultsGrid.innerHTML = `
      <div class="no-results-state">
        <h3>Ingen resultater</h3>
        <p>Ingen varer matcher dine filtre for "${currentQuery}". Prøv at ændre eller fjerne filtre.</p>
      </div>
    `;
    return;
  }

  const cheapestPrice = results.filter(r => r.price !== null)[0]?.price ?? null;

  results.forEach((item, idx) => {
    const card = createProductCard(item, idx === 0 && item.price === cheapestPrice);
    resultsGrid.appendChild(card);
  });
}

// ============================================================
// PRODUCT CARD
// ============================================================

function createProductCard(item, isCheapest) {
  const card = document.createElement('div');
  card.className = 'product-card';
  const delay = Math.min(idx_delay++, 20) * 30;
  card.style.animationDelay = `${delay}ms`;

  // Build badge row
  let badges = '';
  if (isCheapest) badges += `<span class="badge badge-cheapest">⭐ Billigst</span>`;
  if (item.isOrganic) badges += `<span class="badge badge-organic">🌿 Øko</span>`;
  if (item.isOffer)   badges += `<span class="badge badge-offer">% Tilbud</span>`;

  // Image
  const imageContent = item.imageUrl
    ? `<img class="card-image" src="${item.imageUrl}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.parentElement.innerHTML=noImageSvg()">`
    : noImageSvg();

  // Price display
  const priceClass = item.isOffer ? 'price-main is-offer' : 'price-main';
  const priceDisplay = item.price !== null ? formatPrice(item.price) : '–';
  const originalDisplay = item.originalPrice !== null
    ? `<div class="price-original">Var ${formatPrice(item.originalPrice)}</div>`
    : '';

  // Unit price
  const unitDisplay = item.pricePerUnit
    ? `${formatPrice(item.pricePerUnit)} ${item.unitPriceLabel}`
    : '';

  // Valid until
  const validDisplay = item.validUntil
    ? `<div class="price-valid">Tilbud til ${item.validUntil}</div>`
    : '';

  // Brand & size
  const brandSize = [item.brand, item.size].filter(Boolean).join(' · ');

  // Category tag (show subCategory if available, else category)
  const categoryTag = item.subCategory || item.category;

  // Source label
  const sourceLabel = item.source === 'tjek' ? 'Tilbudsavis' : 'nemlig.com';

  // Distance label
  const distanceDisplay = item.source === 'nemlig'
    ? `<span class="distance-chip delivery-chip">🛒 Levering</span>`
    : (item.distanceKm != null ? `<span class="distance-chip">📍 ${formatDistance(item.distanceKm)}</span>` : '');

  card.innerHTML = `
    <div class="card-badge-row">${badges}</div>

    <div class="card-image-wrapper">
      ${imageContent}
    </div>

    <div class="card-body">
      <div class="card-store">${escapeHtml(item.store)}</div>
      <div class="card-name">${escapeHtml(item.name)}</div>
      ${brandSize ? `<div class="card-brand-size">${escapeHtml(brandSize)}</div>` : ''}
      <div class="card-meta-row">
        <span class="source-chip">${sourceLabel}</span>
        ${categoryTag ? `<span class="category-chip">${escapeHtml(categoryTag)}</span>` : ''}
        ${distanceDisplay}
      </div>
    </div>

    <div class="card-price-section">
      <div>
        <div class="${priceClass}">${priceDisplay}</div>
        ${originalDisplay}
        ${validDisplay}
      </div>
      <div class="price-unit">${escapeHtml(unitDisplay)}</div>
    </div>
  `;

  return card;
}

// A module-level counter to stagger card animations
let idx_delay = 0;

// ============================================================
// UTILITIES
// ============================================================

function formatPrice(price) {
  if (price === null || price === undefined) return '–';
  return price.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}

function formatDistance(km) {
  if (km == null) return '';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toLocaleString('da-DK', { maximumFractionDigits: 1 })} km`;
}

function noImageSvg() {
  return `<div class="no-image-placeholder">
    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
    </svg>
    <span>Intet billede</span>
  </div>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Reset animation delay on each new search
function resetIdxDelay() {
  idx_delay = 0;
}

// Patch handleSearch to reset animation delay
const _origHandleSearch = handleSearch;
window.handleSearch = async function() {
  resetIdxDelay();
  await _origHandleSearch();
};
