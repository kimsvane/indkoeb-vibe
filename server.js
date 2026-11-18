import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { callLLM } from './lib/llm.js';
import {
  parseShoppingListHeuristic,
  buildListParsePrompt,
  extractJsonArray,
  normalizeParsedItems,
  inferCategory,
  fallbackQueriesFor
} from './lib/list-parser.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Store locations (OpenStreetMap data, see scripts/build-stores.mjs) ---
let STORE_DATA = { chains: {}, aliases: {} };
try {
  STORE_DATA = JSON.parse(readFileSync(path.join(__dirname, 'lib', 'stores.json'), 'utf8'));
} catch (err) {
  console.warn('[Stores] Kunne ikke indlæse butiksdata:', err.message);
}

// --- ShelfAtlas (optional 3rd price source: regular + campaign prices for DK chains) ---
// Aktiveres kun hvis SHELFATLAS_API_KEY er sat i .env. Giver normalpriser
// ("regular") samt tilbud ("campaign") for fysiske butikker og understøtter geo-søgning.
const SHELFATLAS_API_KEY = process.env.SHELFATLAS_API_KEY || '';
const SHELFATLAS_BASE = process.env.SHELFATLAS_BASE || 'https://api.shelfatlas.com/api/v1/public/catalog';

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parsing for API requests
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Nemlig.com Session Manager ---
const NEMLIG_BASE_URL = "https://www.nemlig.com";
const NEMLIG_SEARCH_URL = "https://webapi.prod.knl.nemlig.it";

const NEMLIG_DEFAULT_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
  "User-Agent": "nemligmcp/0.1.0 (+https://github.com/nemlig/nemligmcp)",
  "Device-Size": "desktop",
  Platform: "web",
  Version: "11.201.0",
  Referer: `${NEMLIG_BASE_URL}/`,
  Origin: NEMLIG_BASE_URL,
};

class NemligSessionManager {
  constructor() {
    this.cookies = {};
    this.xsrfToken = "";
    this.bearerToken = "";
    this.bearerExpiresAt = 0;
    this.timestamp = "";
    this.timeslotUtc = "2026080815-60-180";
    this.deliveryZoneId = "1";
    this.inFlightPromise = null;
  }

  storeCookies(headers) {
    const setCookie = headers.get('set-cookie');
    if (!setCookie) return;
    const cookiesList = headers.getSetCookie ? headers.getSetCookie() : [setCookie];
    for (const cookieStr of cookiesList) {
      const parts = cookieStr.split(';');
      const first = parts[0];
      const eqIdx = first.indexOf('=');
      if (eqIdx > 0) {
        const name = first.substring(0, eqIdx).trim();
        const value = first.substring(eqIdx + 1).trim();
        this.cookies[name] = value;
      }
    }
  }

  getCookieHeader() {
    return Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  hasFreshBearer() {
    const REFRESH_SKEW_MS = 30_000;
    return !!this.bearerToken && Date.now() < this.bearerExpiresAt - REFRESH_SKEW_MS;
  }

  async ensureSession() {
    if (this.hasFreshBearer() && this.xsrfToken && this.timestamp) return;

    if (this.inFlightPromise) {
      await this.inFlightPromise;
      if (this.hasFreshBearer()) return;
    }

    this.inFlightPromise = this.establish();
    try {
      await this.inFlightPromise;
    } finally {
      this.inFlightPromise = null;
    }
  }

  async establish() {
    try {
      console.log("[NemligSession] Establishing anonymous session...");
      
      // Step 1: AntiForgery
      const res1 = await fetch(`${NEMLIG_BASE_URL}/webapi/AntiForgery`, {
        headers: {
          ...NEMLIG_DEFAULT_HEADERS,
          "X-Correlation-Id": crypto.randomUUID()
        }
      });
      this.storeCookies(res1.headers);
      const body1 = await res1.json();
      this.xsrfToken = body1.Value;
      if (!this.xsrfToken) throw new Error("No XSRF token returned");

      // Step 2: Token
      const res2 = await fetch(`${NEMLIG_BASE_URL}/webapi/Token`, {
        headers: {
          ...NEMLIG_DEFAULT_HEADERS,
          "X-Correlation-Id": crypto.randomUUID(),
          "X-XSRF-TOKEN": this.xsrfToken,
          "Cookie": this.getCookieHeader()
        }
      });
      this.storeCookies(res2.headers);
      const body2 = await res2.json();
      this.bearerToken = body2.access_token;
      const expiresInMs = (body2.expires_in ?? 300) * 1000;
      this.bearerExpiresAt = Date.now() + expiresInMs;
      if (!this.bearerToken) throw new Error("No bearer token returned");

      // Step 3: AppSettings
      const res3 = await fetch(`${NEMLIG_BASE_URL}/webapi/v2/AppSettings/Website`, {
        headers: {
          ...NEMLIG_DEFAULT_HEADERS,
          "X-Correlation-Id": crypto.randomUUID(),
          "Authorization": `Bearer ${this.bearerToken}`,
          "X-XSRF-TOKEN": this.xsrfToken,
          "Cookie": this.getCookieHeader()
        }
      });
      this.storeCookies(res3.headers);
      const appSettings = await res3.json();
      this.timestamp = appSettings.CombinedProductsAndSitecoreTimestamp || "";

      // Step 4: PageSettings
      const res4 = await fetch(`${NEMLIG_BASE_URL}/?GetAsJson=1&d=1`, {
        headers: {
          ...NEMLIG_DEFAULT_HEADERS,
          "X-Correlation-Id": crypto.randomUUID(),
          "Authorization": `Bearer ${this.bearerToken}`,
          "X-XSRF-TOKEN": this.xsrfToken,
          "Cookie": this.getCookieHeader()
        }
      });
      this.storeCookies(res4.headers);
      const pageSettings = await res4.json();
      const settings = pageSettings.Settings || {};
      this.timeslotUtc = settings.TimeslotUtc || "2026080815-60-180";
      this.deliveryZoneId = settings.DeliveryZoneId != null ? String(settings.DeliveryZoneId) : "1";
      
      console.log(`[NemligSession] Session established. timeslot=${this.timeslotUtc}, zone=${this.deliveryZoneId}`);
    } catch (err) {
      console.error("[NemligSession] Failed to establish session:", err);
      // Reset tokens on error
      this.xsrfToken = "";
      this.bearerToken = "";
      this.bearerExpiresAt = 0;
      throw err;
    }
  }

  invalidateSession() {
    this.bearerExpiresAt = 0;
    this.bearerToken = "";
  }
}

const nemligSession = new NemligSessionManager();

// --- API Helpers & Normalizers ---

// Haversine distance between two coordinates (in km)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Resolve a store name (as displayed, e.g. normalized chain name) to a chain key in STORE_DATA
function resolveChainKey(storeName) {
  if (!storeName) return null;
  const trimmed = storeName.trim();
  if (STORE_DATA.chains[trimmed]) return trimmed;
  const alias = STORE_DATA.aliases[trimmed.toLowerCase()];
  if (alias && STORE_DATA.chains[alias]) return alias;
  const canonical = normalizeStore(trimmed);
  if (STORE_DATA.chains[canonical]) return canonical;
  return null;
}

// Distance (km) from a coordinate to the nearest branch of the store's chain.
// Returns null if the chain is unknown (no location data).
function nearestStoreDistanceKm(storeName, lat, lon) {
  const key = resolveChainKey(storeName);
  if (!key) return null;
  const branches = STORE_DATA.chains[key];
  if (!branches || branches.length === 0) return null;
  let best = Infinity;
  for (const b of branches) {
    const d = haversineKm(lat, lon, b.lat, b.lon);
    if (d < best) best = d;
  }
  return best === Infinity ? null : Math.round(best * 10) / 10;
}

// Attach distanceKm to a list of results given a user location. Returns the list.
// Kun Tjek-resultater mangler koordinater (de kommer fra vores egen butiksdata);
// ShelfAtlas-resultater har allerede beregnet distanceKm, og nemlig beholdes som null.
function attachDistances(results, lat, lon) {
  for (const r of results) {
    if (r.source === 'tjek') r.distanceKm = nearestStoreDistanceKm(r.store, lat, lon);
  }
  return results;
}

// Parse a lat/lon pair (query params or body fields). Returns {lat, lon} or null.
function parseLocation(lat, lon) {
  const latNum = parseFloat(lat);
  const lonNum = parseFloat(lon);
  if (Number.isNaN(latNum) || Number.isNaN(lonNum)) return null;
  if (Math.abs(latNum) > 90 || Math.abs(lonNum) > 180) return null;
  return { lat: latNum, lon: lonNum };
}

// --- ShelfAtlas integration (optional) ---
// Simpel in-memory TTL-cache til at beskytte mod rate limits.
const _shelfCache = new Map();
function shelfCacheGet(key, ttlMs) {
  const e = _shelfCache.get(key);
  if (e && Date.now() - e.t < ttlMs) return e.v;
  return undefined;
}
function shelfCacheSet(key, v, ttlMs) {
  _shelfCache.set(key, { t: Date.now(), v });
}

let _shelfStores = null;
async function getShelfAtlasStores() {
  if (_shelfStores) return _shelfStores;
  const cached = shelfCacheGet('stores', 60 * 60 * 1000);
  if (cached) { _shelfStores = cached; return cached; }
  const headers = { Authorization: `Bearer ${SHELFATLAS_API_KEY}` };
  const res = await fetch(`${SHELFATLAS_BASE}/stores?limit=500`, { headers });
  if (!res.ok) throw new Error(`ShelfAtlas stores HTTP ${res.status}`);
  const data = await res.json();
  const map = {};
  for (const s of (data.data || [])) {
    map[s.id] = {
      lat: s.lat, lng: s.lng,
      chainName: s.chainName, chainSlug: s.chainSlug,
      name: s.name, city: s.city
    };
  }
  _shelfStores = map;
  shelfCacheSet('stores', map, 60 * 60 * 1000);
  return map;
}

// Normaliser ét ShelfAtlas-tilbud til samme format som Tjek/nemlig-resultater.
function parseShelfAtlasItem(offer, productMap, storeMap, location) {
  const productId = offer.productId || (offer.matchedProductIds && offer.matchedProductIds[0]);
  const product = productId ? productMap[productId] : null;
  const store = offer.storeId ? storeMap[offer.storeId] : null;
  if (!store) return null;

  const name = (product && product.canonicalName) || offer.rawName || 'Ukendt';
  const price = parseFloat(offer.price);
  if (Number.isNaN(price)) return null;

  // ShelfAtlas' /offers er et rent tilbuds-feed: alle poster er kampagnetilbud.
  // (API'en har intet priceKind-felt og eksponerer ikke regulære hyldepriser.)
  const isOffer = true;
  let distanceKm = null;
  if (location && store.lat != null && store.lng != null) {
    distanceKm = Math.round(haversineKm(location.lat, location.lon, store.lat, store.lng) * 10) / 10;
  }

  let size = '';
  if (product && product.volumeMl) size = `${product.volumeMl} ml`;
  else if (product && product.packageSizeValue) size = `${product.packageSizeValue} ${product.packageSizeUnit || ''}`.trim();
  else if (offer.volumeMl) size = `${offer.volumeMl} ml`;

  const pricePerUnit = offer.unitPrice != null ? parseFloat(offer.unitPrice) : null;
  let unitPriceLabel = '';
  if (pricePerUnit != null) {
    if (product && product.volumeMl) unitPriceLabel = 'kr/l';
    else if (product && product.packageSizeUnit === 'kg') unitPriceLabel = 'kr/kg';
    else if (product && product.packageSizeUnit === 'g') unitPriceLabel = 'kr/kg';
  }

  return {
    id: `shelfatlas-${offer.id}`,
    source: 'shelfatlas',
    name,
    brand: '',
    store: store.chainName || store.chainSlug,
    price,
    originalPrice: offer.originalPrice != null ? parseFloat(offer.originalPrice) : null,
    isOffer,
    isOrganic: false,
    category: null,
    size,
    pricePerUnit,
    unitPriceLabel,
    imageUrl: offer.imageUrl || (product && product.imageUrl) || null,
    validUntil: offer.validTo ? new Date(offer.validTo).toLocaleDateString('da-DK') : null,
    distanceKm
  };
}

// Hent tilbudspriser fra ShelfAtlas for et søgeord (kun kampagnetilbud — API'en
// eksponerer ikke regulære hyldepriser). Returnerer [] ved manglende nøgle/fejl.
async function fetchShelfAtlas(query, location = null) {
  if (!SHELFATLAS_API_KEY) return [];
  try {
    const headers = { Authorization: `Bearer ${SHELFATLAS_API_KEY}` };

    const cacheKey = `products:${query.toLowerCase()}`;
    let products = shelfCacheGet(cacheKey, 5 * 60 * 1000);
    if (!products) {
      const prodRes = await fetch(`${SHELFATLAS_BASE}/products?q=${encodeURIComponent(query)}&limit=30`, { headers });
      if (!prodRes.ok) throw new Error(`ShelfAtlas products HTTP ${prodRes.status}`);
      const prodData = await prodRes.json();
      products = prodData.data || [];
      shelfCacheSet(cacheKey, products, 5 * 60 * 1000);
    }
    if (!products.length) return [];

    const productMap = {};
    for (const p of products) productMap[p.id] = p;
    const ids = products.map(p => p.id).join(',');

    const offRes = await fetch(`${SHELFATLAS_BASE}/offers?product_ids=${encodeURIComponent(ids)}&limit=200`, { headers });
    if (!offRes.ok) throw new Error(`ShelfAtlas offers HTTP ${offRes.status}`);
    const offData = await offRes.json();
    const offers = offData.data || [];

    const storeMap = await getShelfAtlasStores();

    // Vælg billigste tilbud per butik+produkt
    const groups = {};
    for (const offer of offers) {
      const pid = offer.productId || (offer.matchedProductIds && offer.matchedProductIds[0]);
      const key = `${offer.storeId}|${pid}`;
      const price = parseFloat(offer.price);
      if (Number.isNaN(price)) continue;
      if (!groups[key] || price < groups[key]._price) groups[key] = { offer, _price: price };
    }

    const items = [];
    for (const { offer } of Object.values(groups)) {
      const item = parseShelfAtlasItem(offer, productMap, storeMap, location);
      if (item) items.push(item);
    }
    return items;
  } catch (err) {
    if (String(err.message).includes('429')) {
      console.error('[Search] ShelfAtlas: gratis kvote opbrugt (HTTP 429) — kun nemlig + Tjek bruges. Skift til partner-/betalingsnøgle for fuld dækning.');
    } else {
      console.error('[Search] ShelfAtlas fejlede:', err.message);
    }
    return [];
  }
}

// Determine if a product is organic (Økologisk)
// NOTE: \b word boundaries in JS regex do NOT work with non-ASCII chars like ø/Ø.
// We use a simple substring match — "øko" is distinctive enough to avoid false positives.
function checkIsOrganic(name, description, labels = []) {
  const regex = /øko(logisk)?/i;
  if (regex.test(name)) return true;
  if (description && regex.test(description)) return true;
  if (labels && labels.some(l => regex.test(l))) return true;
  return false;
}

// --- Category inference for Tjek products (keyword-based, best effort) ---
const TJEK_CATEGORY_MAP = [
  { category: 'Mejeri',          keywords: ['mælk', 'smør', 'ost', 'fløde', 'yoghurt', 'skyr', 'kefir', 'koldskål', 'creme fraiche', 'kvark', 'rømme', 'cremefraiche'] },
  { category: 'Kød & Fisk',     keywords: ['oksekød', 'svinekød', 'kylling', 'kød', 'hakket', 'bøf', 'filet', 'laks', 'fisk', 'rejer', 'tun', 'torsk', 'pålæg', 'bacon', 'medister', 'pølse', 'skinke', 'leverpostej'] },
  { category: 'Frugt & Grønt',  keywords: ['æble', 'banan', 'agurk', 'tomat', 'kartofler', 'løg', 'gulerod', 'salat', 'broccoli', 'spinat', 'grape', 'appelsin', 'citron', 'jordbær', 'blåbær', 'hindbær', 'pære', 'mango', 'avocado', 'peber', 'svamp', 'blomkål', 'grønkål'] },
  { category: 'Brød & Bageri',  keywords: ['brød', 'boller', 'rugbrød', 'franskbrød', 'kage', 'havregryn', 'müsli', 'knækbrød', 'toast', 'croissant', 'baguette'] },
  { category: 'Drikkevarer',    keywords: ['juice', 'sodavand', 'cola', 'pepsi', 'cocio', 'vand', 'øl', 'vin', 'te', 'kaffe', 'kakao', 'energidrik', 'saft', 'smoothie', 'limonade', 'isvand'] },
  { category: 'Frost',          keywords: ['frosne', 'frost', 'is ', 'ispind', 'pizz', 'frozen', 'frysevarer'] },
  { category: 'Slik & Snacks',  keywords: ['chips', 'slik', 'chokolade', 'kiks', 'popcorn', 'nødder', 'mandler', 'vingummi', 'lakridser', 'candy'] },
  { category: 'Konserves & Tørvarer', keywords: ['pasta', 'ris', 'mel', 'sukker', 'olie', 'dåse', 'tomat sauce', 'tomatsauce', 'nudler', 'gryn', 'linser', 'bønner', 'majs', 'suppe'] },
  { category: 'Hygiejne & Rengøring', keywords: ['shampoo', 'sæbe', 'shower', 'tandpasta', 'deodorant', 'vaskemiddel', 'opvask', 'toilet'] },
];

function inferTjekCategory(heading, description) {
  const text = `${heading} ${description || ''}`.toLowerCase();
  for (const { category, keywords } of TJEK_CATEGORY_MAP) {
    if (keywords.some(kw => text.includes(kw))) return category;
  }
  return null;
}

// Normalize store name
function normalizeStore(name) {
  if (!name) return 'Ukendt butik';
  const cleanName = name.trim().toLowerCase();
  
  if (cleanName.includes('rema 1000')) return 'REMA 1000';
  if (cleanName.includes('netto')) return 'Netto';
  if (cleanName.includes('føtex') || cleanName.includes('foetex')) return 'Føtex';
  if (cleanName.includes('bilka')) return 'Bilka';
  if (cleanName.includes('lidl')) return 'Lidl';
  if (cleanName.includes('meny')) return 'Meny';
  if (cleanName.includes('spar')) return 'Spar';
  if (cleanName.includes('365') || cleanName.includes('coop 365')) return 'Coop 365';
  if (cleanName.includes('brugsen') || cleanName.includes('superbrugsen')) return 'SuperBrugsen';
  if (cleanName.includes('kvickly')) return 'Kvickly';
  if (cleanName.includes('nemlig')) return 'nemlig.com';
  
  return name.trim();
}

// Parse quantity and unit price from Tjek (flyer deals)
function parseTjekProduct(item) {
  const price = item.pricing?.price ?? null;
  const prePrice = item.pricing?.pre_price ?? null;
  const isOffer = true; // All Tjek items are active flyer offers
  const store = normalizeStore(item.branding?.name || item.dealer?.name);
  
  const qty = item.quantity?.size?.from ?? null;
  const unit = item.quantity?.unit?.symbol ?? null;
  const pieces = item.quantity?.pieces?.from ?? null;

  let pricePerUnit = null;
  let unitLabel = "";
  let sizeLabel = "";

  if (qty && unit) {
    let rawPricePerUnit = price / qty;
    unitLabel = `kr/${unit}`;
    sizeLabel = `${qty} ${unit}`;
    
    // Normalize small units to kg or Liter
    const normUnit = unit.toLowerCase();
    if (normUnit === 'g') {
      pricePerUnit = rawPricePerUnit * 1000;
      unitLabel = 'kr/kg';
    } else if (normUnit === 'ml') {
      pricePerUnit = rawPricePerUnit * 1000;
      unitLabel = 'kr/l';
    } else if (normUnit === 'cl') {
      pricePerUnit = rawPricePerUnit * 100;
      unitLabel = 'kr/l';
    } else if (normUnit === 'dl') {
      pricePerUnit = rawPricePerUnit * 10;
      unitLabel = 'kr/l';
    } else {
      pricePerUnit = rawPricePerUnit;
    }
  } else if (pieces) {
    pricePerUnit = price / pieces;
    unitLabel = 'kr/stk';
    sizeLabel = `${pieces} stk`;
  } else {
    // Try to parse size from description or heading if available
    sizeLabel = item.description || "";
  }

  const isOrganic = checkIsOrganic(item.heading, item.description || "");
  const category = inferTjekCategory(item.heading, item.description);

  return {
    id: `tjek-${item.id}`,
    source: 'tjek',
    name: item.heading,
    brand: item.description ? item.description.split('/')[1]?.trim() || '' : '',
    store,
    price,
    originalPrice: prePrice,
    isOffer,
    isOrganic,
    category,
    size: sizeLabel,
    pricePerUnit: pricePerUnit ? parseFloat(pricePerUnit.toFixed(2)) : null,
    unitPriceLabel: unitLabel,
    imageUrl: item.images?.view || null,
    validUntil: item.run_till ? new Date(item.run_till).toLocaleDateString('da-DK') : null
  };
}

// Parse Nemlig.com product
function parseNemligProduct(item) {
  const price = item.Price ?? null;
  const isOffer = !!item.DiscountItem;
  const isOrganic = checkIsOrganic(item.Name, item.Description || "", item.Labels || []);
  const store = 'nemlig.com';
  
  // Extract size label from description (e.g. "1 l / Arla ØKO" -> "1 l")
  let sizeLabel = "";
  if (item.Description) {
    sizeLabel = item.Description.split('/')[0]?.trim() || "";
  }

  // Use Nemlig's own category taxonomy (ProductMainGroupName is the top-level, e.g. "Mejeri")
  // Fall back to ProductCategoryGroupName if no main group
  const category = item.ProductMainGroupName || item.ProductCategoryGroupName || item.Category || null;

  return {
    id: `nemlig-${item.Id}`,
    source: 'nemlig',
    name: item.Name || 'Ukendt vare',
    brand: item.Brand || '',
    store,
    price,
    originalPrice: null,
    isOffer,
    isOrganic,
    category,
    subCategory: item.ProductCategoryGroupName || item.SubCategory || null,
    size: sizeLabel,
    pricePerUnit: item.UnitPriceCalc ? parseFloat(item.UnitPriceCalc.toFixed(2)) : null,
    unitPriceLabel: item.UnitPriceLabel ? `kr/${item.UnitPriceLabel.replace('kr/', '')}` : '',
    imageUrl: item.PrimaryImage || null,
    validUntil: null
  };
}

// --- Fælles søgelogik ---
// Bruges af både enkelt-søgning og den store indkøbsliste, så resultater
// behandles ens uanset hvor de kommer fra.

// Fjern mængder/enheder fra en søgestreng ("2 ps 5 kg hvedemel" -> "hvedemel").
// Beskrivende ord som "frisk", "røget" og "frosne" bevares.
function cleanSearchQuery(raw) {
  if (raw == null) return '';
  let q = String(raw)
    .replace(/[•*]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+(?:[.,]\d+)?(?:\s*[-–]\s*\d+(?:[.,]\d+)?)?\s*(?:kg|g|l|liter|dl|cl|ml|stk|styks|pk|ps|pakke|pakker|pose|poser|glas|bundt|bundter|dåse|dåser|fed|hele)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return q || String(raw).trim();
}

async function fetchNemligSearch(query, take = 40) {
  try {
    await nemligSession.ensureSession();
    const queryParams = new URLSearchParams({
      query,
      take: String(take),
      skip: "0",
      recipeCount: "0",
      timestamp: nemligSession.timestamp,
      timeslotUtc: nemligSession.timeslotUtc,
      deliveryZoneId: nemligSession.deliveryZoneId
    });

    const doFetch = () => fetch(`${NEMLIG_SEARCH_URL}/searchgateway/api/search?${queryParams}`, {
      headers: {
        ...NEMLIG_DEFAULT_HEADERS,
        "X-Correlation-Id": crypto.randomUUID(),
        "Authorization": `Bearer ${nemligSession.bearerToken}`
      }
    });

    let response = await doFetch();
    if (response.status === 401) {
      console.warn("[Search] Nemlig returned 401. Refreshing token...");
      nemligSession.invalidateSession();
      await nemligSession.ensureSession();
      response = await doFetch();
    }
    if (!response.ok) throw new Error(`Nemlig HTTP status ${response.status}`);
    const data = await response.json();
    return (data.Products?.Products || []).map(parseNemligProduct);
  } catch (err) {
    console.error("[Search] Nemlig search failed:", err.message);
    return [];
  }
}

async function fetchTjekSearch(query, limit = 100) {
  try {
    const params = new URLSearchParams({ query, country_id: "DK", limit: String(limit) });
    const response = await fetch(`https://api.etilbudsavis.dk/v2/offers/search?${params}`, {
      headers: { 'User-Agent': 'grocery-aggregator/1.0' }
    });
    if (!response.ok) throw new Error(`Tjek HTTP status ${response.status}`);
    const data = await response.json();
    return (Array.isArray(data) ? data : []).map(parseTjekProduct);
  } catch (err) {
    console.error("[Search] Tjek search failed:", err.message);
    return [];
  }
}

// Kortere søgestreng hvis den præcise form ikke gav noget ("frisk mozzarella" -> "mozzarella").
function fallbackQueries(query) {
  const words = query.split(/\s+/).filter(w => w.length > 2);
  const candidates = [];
  if (words.length >= 3) candidates.push(words.slice(-2).join(' '));
  if (words.length >= 2) candidates.push(words[words.length - 1]);
  return [...new Set(candidates)].slice(0, 1);
}

async function runStoreSearch(query, location, take, limit) {
  const [nemligItems, tjekItems, shelfItems] = await Promise.all([
    fetchNemligSearch(query, take),
    fetchTjekSearch(query, limit),
    fetchShelfAtlas(query, location)
  ]);
  return [...nemligItems, ...tjekItems, ...shelfItems];
}

async function searchStorePrices(query, location = null, { take = 40, limit = 100 } = {}) {
  const cacheKey = `store:${query}:${take}:${limit}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) return cached;

  let combined = await runStoreSearch(query, location, take, limit);
  if (combined.length === 0) {
    for (const alt of fallbackQueries(query)) {
      combined = await runStoreSearch(alt, location, take, limit);
      if (combined.length > 0) break;
    }
  }

  if (location) attachDistances(combined, location.lat, location.lon);

  combined.sort((a, b) => {
    if (a.price === null) return 1;
    if (b.price === null) return -1;
    return a.price - b.price;
  });

  setCachedSearch(cacheKey, combined);
  return combined;
}

// --- Express Route for Search ---
app.get('/api/search', async (req, res) => {
  if (!req.query.q) {
    return res.status(400).json({ error: "Søgeord mangler" });
  }

  const query = cleanSearchQuery(req.query.q);
  const location = parseLocation(req.query.lat, req.query.lon);

  console.log(`[Search] New query received: "${query}"${location ? ` (location ${location.lat},${location.lon})` : ''}`);

  try {
    const combined = await searchStorePrices(query, location, { take: 40, limit: 100 });

    // Tjek's keyword search is loose and can return unrelated flyers (e.g. a
    // chocolate bar for "mælk"). Drop clearly irrelevant hits, but keep the raw
    // list if nothing scores positively so a search never becomes empty.
    const searchIngredient = { name: query, searchQuery: query };
    const scored = combined.map(r => ({
      ...r,
      matchScore: scoreProductRelevance(r, searchIngredient)
    }));
    const relevant = scored.filter(r => r.matchScore > 0);
    const results = relevant.length ? relevant : scored;

    const categories = [...new Set(results.map(r => r.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'da'));

    console.log(`[Search] Completed query: "${query}". Total: ${results.length} (raw ${combined.length}), Organic: ${results.filter(r => r.isOrganic).length}`);

    res.json({ query, resultsCount: results.length, categories, results });
  } catch (error) {
    console.error("[Search] Aggregation error:", error);
    res.status(500).json({ error: "Fejl under søgning. Prøv igen." });
  }
});

// --- Helpers for LLM and Recipe Scanning ---

// Strip HTML elements and extract clean raw text
function stripHtml(html) {
  if (!html) return '';
  let text = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '');
  text = text.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<\/p>|<\/div>|<\/li>|<\/h1>|<\/h2>|<\/h3>|<\/h4>|<\/tr>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&aelig;/g, 'æ')
    .replace(/&oslash;/g, 'ø')
    .replace(/&aring;/g, 'å')
    .replace(/&Aelig;/g, 'Æ')
    .replace(/&Oslash;/g, 'Ø')
    .replace(/&Aring;/g, 'Å');

  return text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 2) // Filter out noise lines like single icons/letters
    .join('\n');
}

// Simple parallel execution limiter to avoid rate limits
async function limitParallel(taskGenerators, limit) {
  const results = [];
  const executing = [];
  for (const generator of taskGenerators) {
    const p = Promise.resolve().then(() => generator());
    results.push(p);
    if (limit <= taskGenerators.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

// Memory cache for price searches (5 min TTL)
const searchCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedSearch(query) {
  const cached = searchCache.get(query);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}

function setCachedSearch(query, data) {
  searchCache.set(query, {
    timestamp: Date.now(),
    data
  });
}

// --- API Routes for LLM & Recipe ---

// 0. Get globally configured LLM providers on the server
app.get('/api/llm/config', (req, res) => {
  const providers = {
    gemini: !!process.env.GEMINI_API_KEY,
    anthropic: !!(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY),
    deepseek: !!process.env.DEEPSEEK_API_KEY,
    mistral: !!process.env.MISTRAL_API_KEY,
    openai: !!process.env.OPENAI_API_KEY
  };

  const available = Object.entries(providers)
    .filter(([_, configured]) => configured)
    .map(([name]) => name);

  // Default to the first configured provider
  const defaultProvider = available[0] || null;

  res.json({
    availableProviders: available,
    defaultProvider: defaultProvider
  });
});

// 1. Test connection to LLM
app.post('/api/llm/test', async (req, res) => {
  const { provider, apiKey, baseUrl, model } = req.body;
  
  if (!provider) {
    return res.status(400).json({ error: "LLM provider skal angives ('gemini' eller 'ollama')" });
  }
  
  try {
    console.log(`[LLM Test] Testing connection to ${provider} using model: ${model || 'default'}`);
    const testPrompt = "Svar udelukkende med ordet 'FORBUNDET' (i store bogstaver) for at bekræfte vores forbindelse. Ingen andre tegn.";
    const responseText = await callLLM({ provider, apiKey, baseUrl, model, prompt: testPrompt });
    
    const cleanResponse = responseText.trim().replace(/['"„“.]/g, '');
    if (cleanResponse.includes('FORBUNDET')) {
      res.json({ success: true, message: "Forbindelse oprettet!" });
    } else {
      res.json({ success: true, message: `Forbindelse oprettet, men uventet svar: "${responseText}"` });
    }
  } catch (err) {
    console.error(`[LLM Test] Connection test failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Scan recipe URL and extract ingredients
app.post('/api/recipe/scan', async (req, res) => {
  const { url, provider, apiKey, baseUrl, model } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: "URL mangler" });
  }
  if (!provider) {
    return res.status(400).json({ error: "LLM configuration mangler" });
  }
  
  try {
    console.log(`[Recipe Scan] Fetching recipe from URL: ${url}`);
    const webRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
      }
    });
    
    if (!webRes.ok) {
      throw new Error(`Kunne ikke hente URL. Status: ${webRes.status}`);
    }
    
    const html = await webRes.text();
    const cleanText = stripHtml(html);
    
    // Limit recipe text length to avoid token limits (keep first 8000 chars which contains title + ingredients)
    const truncatedText = cleanText.substring(0, 8000);
    
    console.log(`[Recipe Scan] Cleaned recipe content length: ${cleanText.length} chars (truncated to ${truncatedText.length})`);
    
    const prompt = `Du er en madlavnings- og indkøbsassistent. Du skal analysere teksten fra en opskrifts-hjemmeside.
Din opgave er at udtrække alle ingredienser og returnere dem som en JSON-array af objekter.

Følg disse regler strengt:
1. Hvert objekt skal have præcis disse felter:
   - "name": Råvarens navn på DANSK. Fjern mængder/enheder. Bevar formen (f.eks. "fersk kyllingebryst", "hakket oksekød", "flødeost").
   - "searchQuery": En kort, præcis søgestreng til en supermarkeds-søgemaskine. Brug det vigtigste ord + form, f.eks. "kyllingebryst fersk", "hakket oksekød", "piskefløde". Hvis det er kød eller fisk, der skal bruges fersk/frossen i en varm ret, skal du ALTID tilføje ordet "fersk" (f.eks. "kyllingebryst fersk" eller "laks fersk") for at undgå at søgemaskinen finder pålæg. ALDRIG inkluder mængder.
    - "category": Én af disse kategorier: "kød", "fisk", "mejeri", "grønt", "tørvarer", "brød", "konserves", "krydderier", "frost", "drikkevarer", "andet".
    - "excludeTerms": JSON-array med ord der IKKE må optræde i produktnavnet, mærket eller kategorien. Brug dette til at undgå forkerte produktformer (f.eks. pålæg, skiver, skåret, stegt, dåse). Eksempler: For "kyllingebryst" ekskluder ["pålæg", "pålækker", "skiver", "skåret", "strimler", "nuggets", "hakket", "dåse", "stegt"]. For "oksekød" i en steg-ret, ekskluder ["pålæg", "leverpostej", "hakket"]. For "piskefløde", ekskluder ["flødeost", "is", "creme fraiche"]. Lad listen være tom [] hvis der ikke er risiko for forveksling.
    - "amount": Den mængde af råvaren opskriften bruger, SOM TAL (f.eks. 200, 1.5, 6, 0.5). Hvis mængden ikke står eksplicit i teksten (f.eks. "smag til", "efter behov"), sæt til null.
    - "unit": Enheden SOM STRENG, en af: "g", "kg", "ml", "l", "stk", "fed" (et fed hvidløg), "bundt", "dåse", "pose", "spsk", "tsk", "portion" eller null hvis ukendt. Brug "g"/"kg" for vægt, "ml"/"l" for volumen, "stk" for hele styk (f.eks. "2 æg" -> amount 2, unit "stk"), "fed" for et enkelt fed hvidløg (bemærk at en hel hvidløg indeholder mange fed).
2. Returner KUN den rå JSON-array. Ingen markdown, ingen forklaringer. Array starter med [ og slutter med ].

Opskriftstekst:
${truncatedText}`;

    console.log(`[Recipe Scan] Requesting LLM extraction...`);
    const llmResponse = await callLLM({ provider, apiKey, baseUrl, model, prompt });
    
    // Clean up any markdown codeblock formatting if the LLM didn't obey
    let cleanJsonStr = llmResponse.trim();
    if (cleanJsonStr.startsWith('```')) {
      cleanJsonStr = cleanJsonStr.replace(/^```(json)?/, '').replace(/```$/, '').trim();
    }
    
    console.log(`[Recipe Scan] Parse ingredients JSON:`, cleanJsonStr);
    let parsedIngredients = JSON.parse(cleanJsonStr);
    
    if (!Array.isArray(parsedIngredients)) {
      throw new Error("LLM returnerede ikke et JSON array.");
    }
    
    // Normalize: support both old string format and new object format
    const ingredients = parsedIngredients.map(i => {
      if (typeof i === 'string') {
        return { name: i.trim(), searchQuery: i.trim(), category: 'andet', excludeTerms: [] };
      }
      return {
        name: (i.name || '').trim(),
        searchQuery: (i.searchQuery || i.name || '').trim(),
        category: (i.category || 'andet').trim(),
        excludeTerms: Array.isArray(i.excludeTerms) ? i.excludeTerms.map(t => t.toLowerCase()) : [],
        amount: (i.amount != null && !isNaN(Number(i.amount))) ? Number(i.amount) : null,
        unit: (i.unit || null)
      };
    }).filter(i => i.name);
    
    res.json({
      url,
      ingredients
    });
    
  } catch (err) {
    console.error(`[Recipe Scan] Error scanning recipe:`, err);
    res.status(500).json({ error: `Opskrift-scanning mislykkedes: ${err.message}` });
  }
});

// --- Relevance Scoring for Recipe Ingredients ---
// Word-boundary match that works with Danish letters (\b doesn't handle æøå).
// "mælk" matches "Mælk" and "letmælk 1,5%" only as a compound (handled separately).
function containsWholeWord(text, token) {
  if (!token) return false;
  let from = 0;
  while (from <= text.length - token.length) {
    const i = text.indexOf(token, from);
    if (i === -1) return false;
    const before = i === 0 ? '' : text[i - 1];
    const after = text[i + token.length] || '';
    if (!before || !/[\p{L}\p{N}]/u.test(before)) {
      if (!after || !/[\p{L}\p{N}]/u.test(after)) return true;
    }
    from = i + 1;
  }
  return false;
}

const DANISH_CHAIN_HINTS = [
  'nemlig', 'rema', 'netto', 'føtex', 'foetex', 'bilka', 'lidl', 'meny',
  'spar', 'coop', 'brugsen', 'kvickly', '365', 'fakta', 'abcd', 'kiwi'
];

// Scores a product hit against an ingredient object.
// Returns a number: higher = more relevant.
function scoreProductRelevance(product, ingredient) {
  const productName = (product.name || '').toLowerCase();
  const productBrand = (product.brand || '').toLowerCase();
  const productCat = (product.category || '').toLowerCase();
  const productSubCat = (product.subCategory || '').toLowerCase();
  
  const searchTokens = (ingredient.searchQuery || ingredient.name || '').toLowerCase().split(/\s+/);
  const excludeTerms = ingredient.excludeTerms || [];
  
  let score = 0;
  
  // Hard penalty: if any excluded term appears in product name, brand, category, or subcategory, this match is wrong
  for (const term of excludeTerms) {
    const lowerTerm = term.toLowerCase();
    const checkMatch = (str) => {
      if (!str) return false;
      if (str.includes(lowerTerm)) return true;
      // Special case: if we want to exclude "pålæg", we also exclude "pålækker" and "pålægs"
      if (lowerTerm === 'pålæg' && (str.includes('pålækker') || str.includes('pålægs'))) return true;
      return false;
    };

    if (
      checkMatch(productName) ||
      checkMatch(productBrand) ||
      checkMatch(productCat) ||
      checkMatch(productSubCat)
    ) {
      return -9999; // Effectively blacklisted
    }
  }
  
  // Global penalized terms (deli/processed forms when looking for fresh ingredients)
  const FRESH_CATEGORIES = ['kød', 'fisk', 'mejeri'];
  // NOTE: We don't include 'frys' here so frozen meat/fish can be matched if needed.
  const DELI_TERMS = ['pålæg', 'pålækker', 'skiver', 'skåret', 'skiveskåret', 'røget', 'tørret', 'blandede', 'tilberedt', 'konserve', 'dåse', 'kødboller', 'pølse', 'paté', 'leverpostej', 'tartelet'];
  if (FRESH_CATEGORIES.includes(ingredient.category)) {
    // Don't penalize deli forms when the ingredient itself is a deli product,
    // e.g. "morgenmadspølser", "spegepølser" or "røget laks".
    const isIngredientDeli = searchTokens.some(t => DELI_TERMS.some(term => t.includes(term)));

    if (!isIngredientDeli) {
      for (const term of DELI_TERMS) {
        if (
          productName.includes(term) ||
          productBrand.includes(term) ||
          productCat.includes(term) ||
          productSubCat.includes(term)
        ) {
          score -= 300; // Strong penalty
        }
      }
    }
  }

  // Reward: whole-word matches count much more than matches inside compound words.
  // Example: "Mælk" beats "mælkedrik" and "Kakaomælk" when searching for "mælk".
  const STOPWORDS = new Set(['og', 'af', 'i', 'på', 'til', 'med', 'el', 'eller', 'et', 'en']);
  const meaningfulTokens = searchTokens.filter(t => t.length >= 2 && !STOPWORDS.has(t));
  for (const token of meaningfulTokens) {
    if (containsWholeWord(productName, token)) {
      score += token.length >= 4 ? 70 : 55;
    } else if (productName.includes(token)) {
      score += 35; // compound word ("skummetmælk", "solsikkekerner")
    }
  }

  // The head noun (last word) matters most in Danish: "Snack peberfrugter"
  // must not be satisfied by a product that only contains "snack".
  const head = meaningfulTokens[meaningfulTokens.length - 1];
  if (head) {
    const headMatch = containsWholeWord(productName, head) || productName.includes(head);
    if (headMatch) score += 30;
    else if (meaningfulTokens.length >= 2) score -= 110;
  }

  // Bonus: the product name starts with (or equals) the searched phrase.
  const searchPhrase = meaningfulTokens.join(' ');
  if (searchPhrase && (productName === searchPhrase || productName.startsWith(searchPhrase))) {
    score += 25;
  }

  // Penalty: product is a derivative/processed form (creme, snack, dressing, saft,
  // juice, sauce, suppe, pålæg, postej) of the searched item — usually NOT what the
  // recipe wants. Only penalize when the query itself doesn't contain that word.
  const MODIFIER_TERMS = [
    'creme', 'snack', 'dressing', 'saft', 'juice', 'sauce', 'suppe', 'pålæg',
    'postej', 'drik', 'drikke', 'kakao', 'chokolade', 'vanilje', 'jordbær',
    'pulver', 'blanding'
  ];
  const queryHas = (t) => searchTokens.some(tok => tok.includes(t) || t.includes(tok));
  for (const term of MODIFIER_TERMS) {
    if (productName.includes(term) && !queryHas(term)) {
      score -= 45;
    }
  }

  // "Vindrueis" is ice cream and "Vindruekerneolie" is oil — neither is fruit.
  // Short dessert words need suffix checks so ordinary words like "frisk" or
  // "fisk" are not penalized by a naive substring match.
  if (productName.endsWith('is') && !searchTokens.some(t => t === 'is')) {
    score -= 90;
  }
  if (productName.includes('olie') && !queryHas('olie')) {
    score -= 90;
  }

  // Bonus: product category matches ingredient category
  if (product.category) {
    if (
      (ingredient.category === 'kød' && (productCat.includes('kød') || productCat.includes('fjerkræ') || productSubCat.includes('kød') || productSubCat.includes('fjerkræ'))) ||
      (ingredient.category === 'fisk' && (productCat.includes('fisk') || productSubCat.includes('fisk'))) ||
      (ingredient.category === 'mejeri' && (productCat.includes('mejeri') || productCat.includes('ost') || productCat.includes('mælk') || productSubCat.includes('mejeri') || productSubCat.includes('ost') || productSubCat.includes('mælk'))) ||
      (ingredient.category === 'grønt' && (productCat.includes('grønt') || productCat.includes('frugt') || productCat.includes('salat') || productSubCat.includes('grønt') || productSubCat.includes('frugt') || productSubCat.includes('salat'))) ||
      (ingredient.category === 'brød' && (productCat.includes('brød') || productCat.includes('bageri') || productSubCat.includes('brød') || productSubCat.includes('bageri')))
    ) {
      score += 20;
    }
  }
  
  // Small bonus for being on offer (tie-breaker, not primary)
  if (product.isOffer) score += 2;

  // Tjek also returns flyers from shops far outside the usual Danish chains.
  // Mild penalty so relevant Danish-chain hits win when scores are otherwise equal.
  const store = (product.store || '').toLowerCase();
  if (store && !DANISH_CHAIN_HINTS.some(chain => store.includes(chain))) {
    score -= 12;
  }

  return score;
}

// --- Batch price aggregation (recipe + shopping list) ---

// Search, score and aggregate a list of items. Shared by /api/recipe/prices
// and /api/list/search so both flows get identical matching behaviour.
async function aggregateIngredientPrices(normalizedIngredients, location = null) {
  const tasks = normalizedIngredients.map(ing => async () => {
    // Score a candidate query against the ingredient, so we can tell whether a
    // shorter/singular fallback is actually a better match than the raw text.
    const tryQuery = async (query) => {
      const results = await searchStorePrices(query, location, { take: 25, limit: 40 });
      const scoredIngredient = { ...ing, searchQuery: query };
      const best = results.reduce(
        (max, r) => Math.max(max, scoreProductRelevance(r, scoredIngredient)),
        -9999
      );
      return { query, results, best };
    };

    const primaryQuery = ing.searchQuery || ing.name;
    let chosen = await tryQuery(primaryQuery);

    // Singular/compound variants from the parser help when the plural form
    // ("morgenmadspølser", "vindruer") isn't used in product catalogs. Only try
    // them when the primary search is weak, to keep the extra requests limited.
    if (chosen.best < 45) {
      for (const alt of (ing.fallbackQueries || []).slice(0, 2)) {
        const candidate = await tryQuery(alt);
        if (candidate.best > chosen.best + 5) chosen = candidate;
        if (chosen.best >= 95) break;
      }
    }

    return {
      ingredient: { ...ing, searchQuery: chosen.query },
      results: chosen.results
    };
  });

  // Max 3 concurrent searches to avoid hammering the upstream APIs.
  const searchResults = await limitParallel(tasks, 3);

  const ingredients = searchResults.map(({ ingredient, results }) => {
    const withPrice = results.filter(r => r.price !== null);

    // Tjek mangler koordinater (bruger vores butiksdata); ShelfAtlas har
    // allerede distanceKm; nemlig forbliver null (levering).
    const located = location
      ? withPrice.map(r => ({
          ...r,
          distanceKm: r.source === 'tjek'
            ? nearestStoreDistanceKm(r.store, location.lat, location.lon)
            : (r.distanceKm ?? null)
        }))
      : withPrice;

    const scored = located
      .map(r => ({ ...r, _score: scoreProductRelevance(r, ingredient) }))
      .filter(r => r._score > -9999);

    scored.sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      return (a.price || 99999) - (b.price || 99999);
    });

    const bestScore = scored.length ? scored[0]._score : -9999;
    const confidence = bestScore === -9999 ? 'low'
      : bestScore >= 95 ? 'high'
      : bestScore >= 45 ? 'medium' : 'low';

    // Public results: keep the score as readable metadata for the UI.
    const clean = scored.map(r => {
      const { _score, ...product } = r;
      return { ...product, matchScore: _score };
    });

    return {
      ingredient: ingredient.name,
      itemId: ingredient.id || null,
      searchQuery: ingredient.searchQuery,
      category: ingredient.category,
      amount: ingredient.amount ?? null,
      unit: ingredient.unit ?? null,
      alternativesForQuery: ingredient.alternatives || [],
      question: ingredient.question || null,
      note: ingredient.note || '',
      bestMatch: clean[0] || null,
      organicOption: clean.find(r => r.isOrganic) || null,
      alternatives: clean.slice(0, 60),
      confidence,
      uncertain: confidence !== 'high' || clean.length < 2
    };
  });

  // Anbefal butikken der dækker flest varer.
  const storeCount = {};
  let matchedCount = 0;
  ingredients.forEach(item => {
    if (item.bestMatch) {
      matchedCount++;
      const store = item.bestMatch.store;
      storeCount[store] = (storeCount[store] || 0) + 1;
    }
  });

  let recommendedStore = "Ingen match";
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
    ingredients,
    shelfAtlasActive: !!process.env.SHELFATLAS_API_KEY,
    summary: {
      totalEstimate: parseFloat(totalEstimate.toFixed(2)),
      organicTotalEstimate: parseFloat(organicTotalEstimate.toFixed(2)),
      matchedCount,
      totalCount: ingredients.length,
      uncertainCount: ingredients.filter(i => i.uncertain).length,
      recommendedStore,
      storeMatches: maxMatches
    }
  };
}

// 3. Search and aggregate prices for a list of recipe ingredients
app.post('/api/recipe/prices', async (req, res) => {
  const { ingredients } = req.body || {};

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: "Ingredienser skal angives som et array" });
  }

  const location = parseLocation(req.body.lat, req.body.lon);
  const normalized = normalizeParsedItems(ingredients);
  if (normalized.length === 0) {
    return res.status(400).json({ error: "Ingen gyldige ingredienser" });
  }

  console.log(`[Recipe Prices] Beginning aggregate search for: ${normalized.map(i => i.name).join(', ')}`);

  try {
    res.json(await aggregateIngredientPrices(normalized, location));
  } catch (error) {
    console.error("[Recipe Prices] Processing error:", error);
    res.status(500).json({ error: "Fejl under prissammenligning for opskriften." });
  }
});

// --- Shopping list (long lists, with or without an LLM) ---

// 4. Parse a pasted shopping list. LLM-assisted parsing is optional; when it
// fails (or is disabled) we always fall back to the local heuristic parser.
app.post('/api/list/parse', async (req, res) => {
  const { text, useLLM, provider, apiKey, baseUrl, model } = req.body || {};

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: "Indkøbsliste mangler" });
  }

  const heuristic = normalizeParsedItems(parseShoppingListHeuristic(text));
  if (heuristic.length === 0) {
    return res.status(400).json({ error: "Kunne ikke finde nogen varer i listen." });
  }

  if (!useLLM || !provider) {
    return res.json({ items: heuristic, source: 'heuristic' });
  }

  try {
    console.log(`[List Parse] LLM-assisted parsing with ${provider}`);
    const responseText = await callLLM({
      provider, apiKey, baseUrl, model,
      prompt: buildListParsePrompt(text)
    });

    const parsed = extractJsonArray(responseText);
    let items = normalizeParsedItems(parsed);

    // Never return an empty list just because the LLM misbehaved.
    if (items.length === 0) items = heuristic;

    res.json({ items, source: 'llm' });
  } catch (err) {
    console.warn('[List Parse] LLM parsing failed, using local parser:', err.message);
    res.json({
      items: heuristic,
      source: 'heuristic',
      warning: `AI kunne ikke forstå listen (${err.message}). Derfor blev den lokale læsning brugt i stedet.`
    });
  }
});

// 5. Search prices for the parsed shopping list. Same aggregation as recipes.
app.post('/api/list/search', async (req, res) => {
  const { items } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Varer skal angives som et array" });
  }

  const location = parseLocation(req.body.lat, req.body.lon);
  const normalized = normalizeParsedItems(items);
  if (normalized.length === 0) {
    return res.status(400).json({ error: "Ingen gyldige varer" });
  }

  // Client may have edited a searchQuery manually — strip stray quantities.
  for (const item of normalized) {
    item.searchQuery = cleanSearchQuery(item.searchQuery);
  }

  console.log(`[List Search] Searching ${normalized.length} items: ${normalized.slice(0, 8).map(i => i.name).join(', ')}...`);

  try {
    res.json(await aggregateIngredientPrices(normalized, location));
  } catch (error) {
    console.error("[List Search] Processing error:", error);
    res.status(500).json({ error: "Fejl under søgning efter indkøbslisten." });
  }
});

// --- Data Persistence (JSON files in data/) ---
const DATA_DIR = path.join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function readJsonFile(filename, fallback = {}) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    return JSON.parse(readFileSync(filepath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filename, data) {
  writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2), 'utf8');
}

// --- Tasks (Vareovervågning) ---
let tasksData = readJsonFile('tasks.json', { tasks: [] });
if (!Array.isArray(tasksData.tasks)) tasksData.tasks = [];
function saveTasks() { writeJsonFile('tasks.json', tasksData); }

// --- Notifications config ---
let notificationsData = readJsonFile('notifications.json', {
  services: {
    pushover: { enabled: false, appToken: '', userKey: '' },
    email: { enabled: false, smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', toEmail: '', fromEmail: '' },
    homeassistant: { enabled: false, baseUrl: '', webhookId: '' },
    bluebubbles: { enabled: false, baseUrl: '', password: '', recipient: '' }
  }
});
// Sørg for at alle services findes (f.eks. fra eksisterende data-fil uden bluebubbles)
{
  const defaults = {
    services: {
      pushover: { enabled: false, appToken: '', userKey: '' },
      email: { enabled: false, smtpHost: '', smtpPort: 587, smtpUser: '', smtpPass: '', toEmail: '', fromEmail: '' },
      homeassistant: { enabled: false, baseUrl: '', webhookId: '' },
      bluebubbles: { enabled: false, baseUrl: '', password: '', recipient: '' }
    }
  };
  notificationsData.services = notificationsData.services || {};
  for (const [svc, dflt] of Object.entries(defaults.services)) {
    notificationsData.services[svc] = { ...dflt, ...(notificationsData.services[svc] || {}) };
  }
  saveNotifications();
}
function saveNotifications() { writeJsonFile('notifications.json', notificationsData); }

// --- Generelle indstillinger (persisteret i data/settings.json) ---
let appSettings = readJsonFile('settings.json', {});

app.get('/api/settings', (req, res) => {
  res.json(appSettings);
});

app.post('/api/settings', (req, res) => {
  const incoming = req.body || {};
  appSettings = { ...appSettings, ...incoming };
  writeJsonFile('settings.json', appSettings);
  console.log('[Settings] Indstillinger gemt');
  res.json({ ok: true });
});

// --- Nodemailer transporter (lazy init) ---
let emailTransporter = null;
function getEmailTransporter() {
  const cfg = notificationsData.services?.email;
  if (!cfg?.enabled || !cfg.smtpHost) return null;
  if (!emailTransporter) {
    emailTransporter = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort || 587,
      secure: (cfg.smtpPort === 465),
      auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined
    });
  }
  return emailTransporter;
}

function resetEmailTransporter() { emailTransporter = null; }

// --- Notification Services ---
async function sendPushoverNotification(title, message) {
  const cfg = notificationsData.services?.pushover;
  if (!cfg?.enabled || !cfg.appToken || !cfg.userKey) return;
  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: cfg.appToken,
        user: cfg.userKey,
        title,
        message,
        html: '1'
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[Notify] Pushover fejlede:', res.status, err.errors || err.message || '');
    } else {
      console.log('[Notify] Pushover sendt:', title);
    }
  } catch (err) {
    console.error('[Notify] Pushover fejlede:', err.message);
  }
}

async function sendEmailNotification(subject, text) {
  const cfg = notificationsData.services?.email;
  if (!cfg?.enabled || !cfg.smtpHost || !cfg.toEmail) return;
  const transporter = getEmailTransporter();
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: cfg.fromEmail || cfg.smtpUser,
      to: cfg.toEmail,
      subject,
      text
    });
    console.log('[Notify] E-mail sendt:', subject);
  } catch (err) {
    console.error('[Notify] E-mail fejlede:', err.message);
    resetEmailTransporter();
  }
}

async function sendHomeAssistantNotification(title, message) {
  const cfg = notificationsData.services?.homeassistant;
  if (!cfg?.enabled || !cfg.baseUrl) return;
  try {
    const url = cfg.webhookId
      ? `${cfg.baseUrl.replace(/\/$/, '')}/api/webhook/${cfg.webhookId}`
      : `${cfg.baseUrl.replace(/\/$/, '')}/api/services/notify/notify`;
    const body = cfg.webhookId
      ? { title, message }
      : { message: `${title}: ${message}`, title };
    const headers = { 'Content-Type': 'application/json' };
    if (!cfg.webhookId) {
      // REST API mode — requires Bearer token in webhookId field (repurposed)
      headers['Authorization'] = `Bearer ${cfg.webhookId || ''}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      console.error('[Notify] Home Assistant fejlede:', res.status);
    } else {
      console.log('[Notify] Home Assistant sendt:', title);
    }
  } catch (err) {
    console.error('[Notify] Home Assistant fejlede:', err.message);
  }
}

async function sendBlueBubblesNotification(title, message) {
  const cfg = notificationsData.services?.bluebubbles;
  if (!cfg?.enabled || !cfg.baseUrl || !cfg.password || !cfg.recipient) return { ok: false, skipped: !cfg?.enabled, reason: !cfg?.baseUrl ? 'Server URL mangler' : !cfg?.password ? 'Server Password mangler' : !cfg?.recipient ? 'Ingen modtager(e) angivet' : 'Service ikke aktiveret' };
  try {
    const base = cfg.baseUrl.replace(/\/$/, '');
    const auth = `?password=${encodeURIComponent(cfg.password)}`;
    const fullMessage = `${title}\n${message}`;
    const addresses = cfg.recipient.split(',').map(s => s.trim()).filter(Boolean);
    let sent = 0;

    for (const address of addresses) {
      try {
        // Prøv først at sende til eksisterende chat
        const res = await fetch(`${base}/api/v1/message/text${auth}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatGuid: `any;-;${address}`,
            tempGuid: `temp-${crypto.randomUUID()}`,
            message: fullMessage,
            method: 'private-api'
          })
        });
        const data = await res.json().catch(() => ({}));
        // Hvis chat ikke findes, opret 1-til-1-chat og send
        if (String(data?.error?.message).includes('Chat does not exist')) {
          const res2 = await fetch(`${base}/api/v1/chat/new${auth}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ addresses: [address], message: fullMessage })
          });
          if (res2.ok) { sent++; console.log('[Notify] BlueBubbles (iMessage) oprettet chat + sendt:', address); }
          else console.error('[Notify] BlueBubbles fejlede ved chat-oprettelse for', address, ':', res2.status);
          continue;
        }
        if (res.ok) { sent++; console.log('[Notify] BlueBubbles (iMessage) sendt:', address); }
        else console.error('[Notify] BlueBubbles fejlede:', address, ':', res.status);
      } catch (err) {
        console.error('[Notify] BlueBubbles fejlede:', address, ':', err.message);
        return { ok: false, reason: `${address}: ${err.message}` };
      }
    }
    return sent > 0 ? { ok: true, sent } : { ok: false, reason: 'Ingen besked kunne sendes til nogen modtager' };
  } catch (err) {
    console.error('[Notify] BlueBubbles fejlede:', err.message);
    return { ok: false, reason: err.message };
  }
}

async function sendAllNotifications(title, message) {
  await Promise.allSettled([
    sendPushoverNotification(title, message),
    sendEmailNotification(title, message),
    sendHomeAssistantNotification(title, message),
    sendBlueBubblesNotification(title, message)
  ]);
}

// --- Scheduler ---
const FREQ_MS = {
  daily: 24 * 60 * 60 * 1000,
  'twice-weekly': 3.5 * 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
};

// Prishistorik gemmes pr. opgave i op til 30 dage.
const HISTORY_DAYS = 30;
const MAX_HISTORY_PER_TASK = 300;

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pruneHistory(task) {
  const cutoff = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  task.history = (task.history || []).filter(h => {
    const ts = Date.parse(h?.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  }).slice(-MAX_HISTORY_PER_TASK);
}

// Beregn normalpris ud fra de sidste 30 dage. Ikke-tilbudsobservationer
// foretrækkes, men hvis der kun findes tilbud bruges medianen af dem alle.
function priceStats(task) {
  const entries = (task.history || []).filter(h => h && h.price != null);
  const unitEntries = entries.filter(h => h.pricePerUnit != null && h.pricePerUnit > 0);
  const nonOfferUnit = unitEntries.filter(h => !h.isOffer).map(h => h.pricePerUnit);
  const allUnit = unitEntries.map(h => h.pricePerUnit);
  const nonOfferPrices = entries.filter(h => !h.isOffer).map(h => h.price);
  const allPrices = entries.map(h => h.price);

  return {
    days: HISTORY_DAYS,
    samples: entries.length,
    normalPrice: median(nonOfferPrices) ?? median(allPrices),
    normalUnitPrice: median(nonOfferUnit) ?? median(allUnit),
    lowestPrice: allPrices.length ? Math.min(...allPrices) : null,
    highestPrice: allPrices.length ? Math.max(...allPrices) : null,
    lowestUnitPrice: allUnit.length ? Math.min(...allUnit) : null,
    highestUnitPrice: allUnit.length ? Math.max(...allUnit) : null
  };
}

// “Reelt tilbud” = prisen er tydeligt under den observerede normalpris.
// Kræver mindst 3 prispunkter, ellers er konklusionen ukendt.
function assessPrice(product, stats) {
  if (!product || stats.samples < 3) {
    return { status: 'unknown', discountPercent: null, reason: 'For få prispunkter i de sidste 30 dage.' };
  }
  const useUnit = product.pricePerUnit != null && stats.normalUnitPrice != null;
  const current = useUnit ? product.pricePerUnit : product.price;
  const normal = useUnit ? stats.normalUnitPrice : stats.normalPrice;
  if (normal == null || normal <= 0 || current == null) {
    return { status: 'unknown', discountPercent: null, reason: 'Ikke nok data til at sammenligne priser.' };
  }

  const pct = Math.round((1 - current / normal) * 100);
  if (pct >= 8) return { status: 'real_discount', discountPercent: pct, reason: `${pct}% under normalprisen` };
  if (pct > -8) return { status: 'normal_price', discountPercent: pct, reason: 'Prisen ligger tæt på normalprisen' };
  return { status: 'higher_than_normal', discountPercent: pct, reason: `Prisen er ${Math.abs(pct)}% over normalprisen` };
}

function pushHistory(task, entry) {
  task.history = task.history || [];
  task.history.push({ ...entry, ts: new Date().toISOString() });
  pruneHistory(task);
}

// Ryd op i historik, der er ældre end 30 dage, når serveren starter.
tasksData.tasks.forEach(pruneHistory);
saveTasks();

// AI-konfiguration er persistent på serveren (data/settings.json) eller kan
// komme fra miljøvariabler. Scheduleren kører uden browser, så den kan ikke
// bruge window.getAIConfig().
function getServerAiConfig() {
  const saved = appSettings?.aiConfig;
  if (saved && saved.connected && saved.provider) {
    return {
      provider: saved.provider,
      apiKey: saved.apiKey || undefined,
      baseUrl: saved.baseUrl || (saved.provider === 'ollama' ? saved.ollamaUrl : undefined),
      model: saved.model || (saved.provider === 'ollama' ? saved.ollamaModel : undefined)
    };
  }
  if (process.env.GEMINI_API_KEY) return { provider: 'gemini', apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
  if (process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', apiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY, model: process.env.CLAUDE_MODEL };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL };
  if (process.env.DEEPSEEK_API_KEY) return { provider: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL };
  if (process.env.MISTRAL_API_KEY) return { provider: 'mistral', apiKey: process.env.MISTRAL_API_KEY, model: process.env.MISTRAL_MODEL };
  return null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} tog for lang tid`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Ask the configured LLM to (1) pick the candidate that really matches the
 * monitored query and (2) decide whether the current price is a real discount
 * compared with the last 30 days. Always degrades gracefully to local logic.
 */
async function aiAssessTask(task, candidates, stats, localAssessment) {
  const cfg = getServerAiConfig();
  if (!cfg) return null;

  const candidateJson = candidates.slice(0, 10).map(p => ({
    id: p.id,
    name: p.name,
    brand: p.brand || '',
    store: p.store,
    size: p.size || '',
    price: p.price,
    pricePerUnit: p.pricePerUnit,
    unitPriceLabel: p.unitPriceLabel || '',
    isOffer: !!p.isOffer
  }));
  const historyJson = (task.history || []).slice(-24).map(h => ({
    date: String(h.ts || '').slice(0, 10),
    name: h.name,
    store: h.store,
    price: h.price,
    pricePerUnit: h.pricePerUnit,
    isOffer: !!h.isOffer
  }));

  const prompt = `Du er en dansk prisanalytiker. En bruger overvåger varen "${task.query}".

Kandidatprodukter fundet nu (JSON):
${JSON.stringify(candidateJson)}

Observationer fra de sidste ${HISTORY_DAYS} dage (JSON):
${JSON.stringify(historyJson)}

Lokal foreløbig prisvurdering: ${JSON.stringify(localAssessment)}.

Vælg kun ét af kandidatprodukterne som det, der reelt matcher "${task.query}". Vær kritisk: "mælkedrik" matcher ikke "mælk", "vindrueis" matcher ikke "vindruer", og et tilbehør matcher ikke hovedvaren.

Returnér KUN en JSON-array med præcis ét objekt med felterne:
- "selectedId": id'et fra kandidatlisten, eller null hvis ingen matcher.
- "isCorrectProduct": true/false.
- "productConfidence": "high", "medium" eller "low".
- "productReason": kort dansk forklaring (maks 160 tegn).
- "priceStatus": "real_discount", "normal_price", "higher_than_normal" eller "unknown". Brug "real_discount" kun når prisen er tydeligt lavere end normalprisen i historikken (sammenlign pricePerUnit når muligt).
- "priceReason": kort dansk forklaring (maks 160 tegn).
- "discountPercent": heltal eller null.
- "normalUnitPrice": tal eller null.

Brug ikke markdown og opfind ikke priser.`;

  try {
    const raw = await withTimeout(callLLM({ ...cfg, prompt }), 25000, 'AI-vurdering');
    const parsed = extractJsonArray(raw);
    const r = parsed && parsed[0];
    if (!r || typeof r !== 'object') return null;

    const selectedId = r.selectedId || null;
    const selected = selectedId ? candidates.find(p => p.id === selectedId) : null;
    const statuses = ['real_discount', 'normal_price', 'higher_than_normal', 'unknown'];
    const status = statuses.includes(r.priceStatus) ? r.priceStatus : localAssessment.status;
    const rawDiscount = Number(r.discountPercent);
    const rawNormal = Number(r.normalUnitPrice);
    const discountPercent = status === 'unknown'
      ? null
      : Number.isFinite(rawDiscount) ? rawDiscount : localAssessment.discountPercent;
    const normalUnitPrice = Number.isFinite(rawNormal) && rawNormal > 0
      ? rawNormal
      : stats.normalUnitPrice ?? null;

    return {
      aiPowered: true,
      selectedId: selected ? selected.id : null,
      selectedProduct: selected ? { name: selected.name, store: selected.store, price: selected.price } : null,
      isCorrectProduct: selected ? r.isCorrectProduct !== false : false,
      productConfidence: ['high', 'medium', 'low'].includes(r.productConfidence) ? r.productConfidence : 'medium',
      productReason: String(r.productReason || '').slice(0, 200),
      status,
      reason: String(r.priceReason || '').slice(0, 200),
      discountPercent,
      normalUnitPrice,
      source: 'ai'
    };
  } catch (err) {
    console.warn(`[Scheduler] AI-vurdering fejlede for "${task.query}":`, err.message);
    return null;
  }
}

function formatUnitPrice(item) {
  if (item.pricePerUnit == null) return '';
  const unitLabel = item.unitPriceLabel || '';
  return `${item.pricePerUnit.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${unitLabel}`.trim();
}

function formatKr(value) {
  if (value == null || !Number.isFinite(Number(value))) return '';
  return `${Number(value).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
}

function priceVerdictLabel(status) {
  return {
    real_discount: 'Reelt tilbud',
    normal_price: 'Normalpris (ikke et reelt tilbud)',
    higher_than_normal: 'Dyrere end normalprisen',
    unknown: 'Prisvurdering ikke mulig endnu'
  }[status] || 'Prisvurdering ikke mulig endnu';
}

// Hent kandidater til én overvåget vare. Bruger de samme parsers/søgefunktioner
// som resten af appen, så priser og produktnavne behandles ens overalt.
async function fetchTaskCandidates(query, selectedChains) {
  const chains = Array.isArray(selectedChains) ? selectedChains : [];
  const sources = [];

  if (chains.length === 0 || chains.includes('nemlig.com')) {
    sources.push(fetchNemligSearch(query, 25).catch(err => {
      console.warn('[Scheduler] Nemlig-søgning fejlede:', err.message);
      return [];
    }));
  }
  sources.push(fetchTjekSearch(query, 50).catch(err => {
    console.warn('[Scheduler] Tjek-søgning fejlede:', err.message);
    return [];
  }));
  sources.push(fetchShelfAtlas(query).catch(err => {
    console.warn('[Scheduler] ShelfAtlas-søgning fejlede:', err.message);
    return [];
  }));

  const groups = await Promise.all(sources);
  let items = groups.flat().filter(item => item && item.price != null);

  if (chains.length > 0) {
    items = items.filter(item => chains.includes(item.store));
  }

  // Samme produkt kan optræde i flere kilder. Behold den første forekomst.
  const seen = new Set();
  return items.filter(item => {
    const key = `${(item.store || '').toLowerCase()}|${(item.name || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isTaskDue(task) {
  if (!task.enabled) return false;
  const freq = FREQ_MS[task.frequency] || FREQ_MS.weekly;
  if (!task.lastChecked) return true;
  return (Date.now() - new Date(task.lastChecked).getTime()) >= freq;
}

async function runTask(task) {
  console.log(`[Scheduler] Kører søgning for "${task.query}"...`);
  task.lastChecked = new Date().toISOString();
  pruneHistory(task);

  try {
    const searchQuery = cleanSearchQuery(task.query) || task.query;
    const ingredient = {
      name: task.query,
      searchQuery,
      category: inferCategory(task.query)
    };

    // Prøv først den rensede søgestreng. Hvis den ikke giver et sikkert match,
    // prøves et par kendte synonymer/entalsformer ("vindruer" -> "druer").
    const candidates = [];
    const seenCandidates = new Set();
    const queries = [searchQuery, ...fallbackQueriesFor(searchQuery)].slice(0, 3);
    for (const query of queries) {
      const found = await fetchTaskCandidates(query, task.chains);
      let bestScore = -9999;
      for (const product of found) {
        const key = `${(product.store || '').toLowerCase()}|${(product.name || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
        if (seenCandidates.has(key)) continue;
        seenCandidates.add(key);
        candidates.push(product);
        bestScore = Math.max(bestScore, scoreProductRelevance(product, ingredient));
      }
      if (bestScore >= 90) break;
    }

    const scored = candidates
      .map(product => ({ ...product, _relevance: scoreProductRelevance(product, ingredient) }))
      .filter(product => product._relevance > -100)
      .sort((a, b) => {
        if (Math.abs(b._relevance - a._relevance) > 12) return b._relevance - a._relevance;
        if (a.isOffer !== b.isOffer) return a.isOffer ? -1 : 1;
        return a.price - b.price;
      });

    const top = scored.slice(0, 10);
    const localProduct = top.find(product => product.isOffer && product._relevance >= 35) || top[0] || null;
    const stats = priceStats(task);
    const localPrice = assessPrice(localProduct, stats);
    const localConfidence = !localProduct ? 'low'
      : localProduct._relevance >= 80 ? 'high'
      : localProduct._relevance >= 35 ? 'medium' : 'low';

    const localAssessment = {
      aiPowered: false,
      source: 'local',
      selectedId: localProduct?.id || null,
      selectedProduct: localProduct ? {
        name: localProduct.name,
        store: localProduct.store,
        price: localProduct.price
      } : null,
      isCorrectProduct: !!localProduct && localProduct._relevance >= 35,
      productConfidence: localConfidence,
      productReason: localProduct
        ? `Lokal søgning matchede "${localProduct.name}" (relevans ${localProduct._relevance}).`
        : 'Ingen sikker lokal match fundet.',
      status: localPrice.status,
      reason: localPrice.reason,
      discountPercent: localPrice.discountPercent,
      normalPrice: stats.normalPrice,
      normalUnitPrice: stats.normalUnitPrice
    };

    // AI er valgfri: hvis den ikke er konfigureret eller fejler, bruges den
    // lokale vurdering ovenfor. AI vælger den rigtige vare og bedømmer prisen.
    const aiAssessment = top.length > 0
      ? await aiAssessTask(task, top, stats, localAssessment)
      : null;
    const assessment = aiAssessment || localAssessment;

    const selectedId = assessment.selectedId || null;
    const selected = selectedId ? top.find(product => product.id === selectedId) || null : null;
    // AI vælger varen, men den tal-baserede prisvurdering beregnes lokalt ud fra
    // den faktiske 30-dages historik. Det undgår gæt fra modellen.
    const selectedPrice = assessPrice(selected, stats);
    const finalAssessment = {
      ...assessment,
      selectedProduct: selected ? {
        name: selected.name,
        store: selected.store,
        price: selected.price,
        size: selected.size || ''
      } : null,
      isCorrectProduct: !!selected && assessment.isCorrectProduct !== false,
      status: selectedPrice.status,
      reason: selectedPrice.reason,
      discountPercent: selectedPrice.discountPercent,
      normalPrice: stats.normalPrice,
      normalUnitPrice: stats.normalUnitPrice,
      priceSource: '30-day-history',
      aiPriceNote: assessment.reason || '',
      at: new Date().toISOString(),
      searchQuery,
      candidateCount: top.length,
      productScore: selected?._relevance ?? null,
      rawOffer: !!selected?.isOffer,
      historySamples: stats.samples
    };
    task.lastAssessment = finalAssessment;

    if (finalAssessment.isCorrectProduct && selected) {
      task.bestPrice = selected.price;
      task.bestStore = selected.store;

      pushHistory(task, {
        name: selected.name,
        store: selected.store,
        price: selected.price,
        pricePerUnit: selected.pricePerUnit,
        unitPriceLabel: selected.unitPriceLabel,
        size: selected.size,
        isOffer: !!selected.isOffer,
        correctProduct: true,
        source: finalAssessment.source,
        productScore: selected._relevance
      });
    }

    saveTasks();

    const shouldNotify = finalAssessment.isCorrectProduct && selected && selected.isOffer;
    if (!shouldNotify) {
      if (selected?.isOffer && !finalAssessment.isCorrectProduct) {
        console.warn(`[Scheduler] Sprang notifikation over for "${task.query}": fundet vare matcher ikke søgningen — ${finalAssessment.productReason}`);
      } else {
        console.log(`[Scheduler] Ingen relevant tilbudsvare for "${task.query}" lige nu.`);
      }
      return;
    }

    const unitShort = (selected.unitPriceLabel || 'kr/kg').replace(/^kr\//, '') || 'kg';
    const sizeStr = selected.size ? ` (${selected.size})` : '';
    const priceStr = formatKr(selected.price);
    const unitStr = formatUnitPrice(selected);
    const verdict = priceVerdictLabel(finalAssessment.status);
    const discountStr = Number.isFinite(finalAssessment.discountPercent) && Math.abs(finalAssessment.discountPercent) >= 1
      ? `, ${Math.abs(finalAssessment.discountPercent)}% ${finalAssessment.discountPercent >= 0 ? 'under' : 'over'} normalprisen`
      : '';
    const normalStr = finalAssessment.normalUnitPrice != null
      ? `Normalpris: ${finalAssessment.normalUnitPrice.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr/${unitShort}. `
      : '';
    const productCheckStr = finalAssessment.aiPowered
      ? `AI-varetjek: ${finalAssessment.productReason}`
      : `Lokalt varetjek: ${finalAssessment.productReason}`;
    const priceCheckStr = `Prisvurdering: ${verdict}${discountStr}. ${normalStr}${finalAssessment.reason || ''}`;

    const msg = [
      `${task.query} — ${verdict}`,
      `${selected.name}${sizeStr} i ${selected.store}`,
      `${priceStr}${unitStr ? ` — ${unitStr}` : ''}`,
      priceCheckStr,
      productCheckStr
    ].filter(Boolean).join('\n');

    const title = finalAssessment.status === 'real_discount'
      ? `Reelt tilbud: ${task.query}`
      : finalAssessment.status === 'normal_price'
        ? `Prischeck: ${task.query} (normalpris)`
        : finalAssessment.status === 'higher_than_normal'
          ? `Prischeck: ${task.query} (over normalpris)`
          : `Tilbud: ${task.query}`;

    await sendAllNotifications(title, msg);
    task.lastNotified = new Date().toISOString();
    saveTasks();
    console.log(`[Scheduler] ${title}: ${priceStr} i ${selected.store} — ${verdict}${unitStr ? ` (${unitStr})` : ''}`);
  } catch (err) {
    console.error(`[Scheduler] Fejl for "${task.query}":`, err.message);
    task.lastChecked = new Date().toISOString();
    saveTasks();
  }
}

async function runScheduler() {
  const dueTasks = tasksData.tasks.filter(isTaskDue);
  if (dueTasks.length === 0) return;
  console.log(`[Scheduler] ${dueTasks.length} opgave(r) er due, kører søgninger...`);
  for (const task of dueTasks) {
    await runTask(task);
    // Small delay between tasks to avoid rate-limiting
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Start scheduler: check every 15 minutes
setInterval(runScheduler, 15 * 60 * 1000);
console.log('[Scheduler] Prisovervågningsscheduler startet (hvert 15. minut)');

// --- API Routes: Tasks (Vareovervågning) ---
app.get('/api/tasks/chains', (req, res) => {
  const chains = Object.keys(STORE_DATA.chains || {}).concat(['nemlig.com']);
  res.json({ chains });
});

app.get('/api/tasks', (req, res) => {
  res.json(tasksData);
});

// 30-dages prishistorik for én overvåget vare, inkl. beregnet normalpris og
// seneste AI/lokal vurdering.
app.get('/api/tasks/:id/history', (req, res) => {
  const task = tasksData.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Opgave ikke fundet' });
  pruneHistory(task);
  saveTasks();
  res.json({
    taskId: task.id,
    query: task.query,
    days: HISTORY_DAYS,
    history: task.history || [],
    stats: priceStats(task),
    lastAssessment: task.lastAssessment || null
  });
});

app.post('/api/tasks', (req, res) => {
  const { query, frequency, chains } = req.body;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Søgeord mangler' });
  }
  const validFreqs = ['daily', 'twice-weekly', 'weekly'];
  const freq = validFreqs.includes(frequency) ? frequency : 'weekly';
  const task = {
    id: crypto.randomUUID(),
    query: query.trim(),
    frequency: freq,
    chains: Array.isArray(chains) ? chains : [],
    createdAt: new Date().toISOString(),
    lastChecked: null,
    lastNotified: null,
    enabled: true,
    bestPrice: null,
    bestStore: null,
    history: []
  };
  tasksData.tasks.push(task);
  saveTasks();
  console.log(`[Tasks] Tilføjet: "${task.query}" (${task.frequency}) butikker: [${task.chains.join(', ') || 'alle'}]`);
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const idx = tasksData.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Opgave ikke fundet' });
  const removed = tasksData.tasks.splice(idx, 1)[0];
  saveTasks();
  console.log(`[Tasks] Slettet: "${removed.query}"`);
  res.json({ ok: true });
});

app.post('/api/tasks/:id/toggle', (req, res) => {
  const task = tasksData.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Opgave ikke fundet' });
  task.enabled = !task.enabled;
  saveTasks();
  console.log(`[Tasks] ${task.enabled ? 'Aktiveret' : 'Deaktiveret'}: "${task.query}"`);
  res.json(task);
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = tasksData.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Opgave ikke fundet' });
  const { chains, frequency } = req.body;
  if (Array.isArray(chains)) task.chains = chains;
  if (frequency && ['daily', 'twice-weekly', 'weekly'].includes(frequency)) task.frequency = frequency;
  saveTasks();
  console.log(`[Tasks] Opdateret: "${task.query}" butikker: [${task.chains?.join(', ') || 'alle'}]`);
  res.json(task);
});

app.post('/api/tasks/run', async (req, res) => {
  const { id } = req.body || {};
  if (id) {
    const task = tasksData.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Opgave ikke fundet' });
    await runTask(task);
    res.json(task);
  } else {
    // Run all enabled tasks
    const enabled = tasksData.tasks.filter(t => t.enabled);
    for (const task of enabled) {
      await runTask(task);
      await new Promise(r => setTimeout(r, 1000));
    }
    res.json({ ok: true, ran: enabled.length });
  }
});

// --- API Routes: Notifications ---
app.get('/api/notifications', (req, res) => {
  // Return config without exposing secrets in full
  const cfg = JSON.parse(JSON.stringify(notificationsData));
  // Mask passwords/tokens for display
  if (cfg.services?.pushover?.appToken) cfg.services.pushover.appToken = '***';
  if (cfg.services?.pushover?.userKey) cfg.services.pushover.userKey = '***';
  if (cfg.services?.email?.smtpPass) cfg.services.email.smtpPass = '***';
  if (cfg.services?.homeassistant?.webhookId) cfg.services.homeassistant.webhookId = '***';
  if (cfg.services?.bluebubbles?.password) cfg.services.bluebubbles.password = '***';
  res.json(cfg);
});

app.post('/api/notifications', (req, res) => {
  const incoming = req.body;
  if (!incoming?.services) {
    return res.status(400).json({ error: 'Ugyldig konfiguration' });
  }
  // Merge: only update fields that are sent (don't overwrite secrets with '***')
  const s = incoming.services;
  const cur = notificationsData.services;
  if (s.pushover) {
    cur.pushover.enabled = !!s.pushover.enabled;
    if (s.pushover.appToken && s.pushover.appToken !== '***') cur.pushover.appToken = s.pushover.appToken;
    if (s.pushover.userKey && s.pushover.userKey !== '***') cur.pushover.userKey = s.pushover.userKey;
  }
  if (s.email) {
    cur.email.enabled = !!s.email.enabled;
    if (s.email.smtpHost) cur.email.smtpHost = s.email.smtpHost;
    if (s.email.smtpPort) cur.email.smtpPort = parseInt(s.email.smtpPort) || 587;
    if (s.email.smtpUser) cur.email.smtpUser = s.email.smtpUser;
    if (s.email.smtpPass && s.email.smtpPass !== '***') cur.email.smtpPass = s.email.smtpPass;
    if (s.email.toEmail) cur.email.toEmail = s.email.toEmail;
    if (s.email.fromEmail) cur.email.fromEmail = s.email.fromEmail;
  }
  if (s.homeassistant) {
    cur.homeassistant.enabled = !!s.homeassistant.enabled;
    if (s.homeassistant.baseUrl) cur.homeassistant.baseUrl = s.homeassistant.baseUrl;
    if (s.homeassistant.webhookId && s.homeassistant.webhookId !== '***') cur.homeassistant.webhookId = s.homeassistant.webhookId;
  }
  if (s.bluebubbles) {
    cur.bluebubbles.enabled = !!s.bluebubbles.enabled;
    if (s.bluebubbles.baseUrl) cur.bluebubbles.baseUrl = s.bluebubbles.baseUrl;
    if (s.bluebubbles.password && s.bluebubbles.password !== '***') cur.bluebubbles.password = s.bluebubbles.password;
    if (s.bluebubbles.recipient) cur.bluebubbles.recipient = s.bluebubbles.recipient;
  }
  resetEmailTransporter();
  saveNotifications();
  console.log('[Notifications] Konfiguration gemt');
  res.json({ ok: true });
});

app.post('/api/notifications/test', async (req, res) => {
  const { service } = req.body || {};
  const title = 'PrisJagt testnotifikation';
  const message = 'Dette er en test fra PrisJagt. Notifikationerne fungerer!';
  try {
    let result;
    if (service === 'bluebubbles') {
      result = await sendBlueBubblesNotification(title, message);
      if (!result.ok) return res.status(400).json({ ok: false, error: result.reason || 'iMessage-konfiguration mangler eller fejlede' });
      return res.json({ ok: true });
    }
    if (service === 'pushover') await sendPushoverNotification(title, message);
    else if (service === 'email') await sendEmailNotification(title, message);
    else if (service === 'homeassistant') await sendHomeAssistantNotification(title, message);
    else return res.status(400).json({ error: 'Ugyldig service' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` Dansk Indkøbssøgemaskine running on port ${PORT}`);
  console.log(` Open http://localhost:${PORT} in your browser`);
  console.log(`==================================================`);
});
