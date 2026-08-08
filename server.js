import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { callLLM } from './lib/llm.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// --- Express Route for Search ---
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: "Søgeord mangler" });
  }

  console.log(`[Search] New query received: "${query}"`);
  
  const results = [];
  
  // 1. Fetch from Nemlig.com
  const fetchNemlig = async () => {
    try {
      await nemligSession.ensureSession();
      const queryParams = new URLSearchParams({
        query,
        take: "40",
        skip: "0",
        recipeCount: "0",
        timestamp: nemligSession.timestamp,
        timeslotUtc: nemligSession.timeslotUtc,
        deliveryZoneId: nemligSession.deliveryZoneId
      });
      
      const response = await fetch(`${NEMLIG_SEARCH_URL}/searchgateway/api/search?${queryParams}`, {
        headers: {
          ...NEMLIG_DEFAULT_HEADERS,
          "X-Correlation-Id": crypto.randomUUID(),
          "Authorization": `Bearer ${nemligSession.bearerToken}`
        }
      });
      
      if (response.status === 401) {
        console.warn("[Search] Nemlig returned 401. Refreshing token...");
        nemligSession.invalidateSession();
        await nemligSession.ensureSession();
        // Retry
        const responseRetry = await fetch(`${NEMLIG_SEARCH_URL}/searchgateway/api/search?${queryParams}`, {
          headers: {
            ...NEMLIG_DEFAULT_HEADERS,
            "X-Correlation-Id": crypto.randomUUID(),
            "Authorization": `Bearer ${nemligSession.bearerToken}`
          }
        });
        const data = await responseRetry.json();
        return (data.Products?.Products || []).map(parseNemligProduct);
      }
      
      const data = await response.json();
      return (data.Products?.Products || []).map(parseNemligProduct);
    } catch (err) {
      console.error("[Search] Nemlig search failed:", err.message);
      return []; // Return empty list on failure rather than crashing
    }
  };

  // 2. Fetch from eTilbudsavis/Tjek API
  const fetchTjek = async () => {
    try {
      const params = new URLSearchParams({
        query,
        country_id: "DK",
        limit: "100" // Fetch a high number to cover various stores
      });
      
      const response = await fetch(`https://api.etilbudsavis.dk/v2/offers/search?${params}`, {
        headers: {
          'User-Agent': 'grocery-aggregator/1.0'
        }
      });
      
      if (!response.ok) throw new Error(`Tjek HTTP status ${response.status}`);
      const data = await response.json();
      return data.map(parseTjekProduct);
    } catch (err) {
      console.error("[Search] Tjek search failed:", err.message);
      return [];
    }
  };

  try {
    // Run both searches in parallel
    const [nemligItems, tjekItems] = await Promise.all([fetchNemlig(), fetchTjek()]);
    
    // Combine items
    const combined = [...nemligItems, ...tjekItems];
    
    // Sort: cheapest first. If price is null, push to the end.
    combined.sort((a, b) => {
      if (a.price === null) return 1;
      if (b.price === null) return -1;
      return a.price - b.price;
    });

    // Collect unique categories (sorted, nulls excluded)
    const categories = [...new Set(combined.map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'da'));

    const organicCount = combined.filter(r => r.isOrganic).length;
    console.log(`[Search] Completed query: "${query}". Nemlig: ${nemligItems.length}, Tjek: ${tjekItems.length}, Total: ${combined.length}, Organic: ${organicCount}, Categories: ${categories.join(', ')}`);
    
    res.json({
      query,
      resultsCount: combined.length,
      categories,
      results: combined
    });
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
    
    const prompt = `Du er en madlavnings- og indkøbsassistent. Du skal analysere den medfølgende tekst fra en opskrifts-hjemmeside.
Din opgave er at udtrække alle ingredienser og returnere dem som en ren JSON-array af strenge.

Følg disse regler strengt:
1. Hver streng i JSON-arrayet skal KUN være navnet på selve råvaren på DANSK (f.eks. "hakket oksekød", "piskefløde", "løg", "tomatpuré").
2. Du skal fjerne alle mængder, vægte og enheder (f.eks. fjerne "500 g", "3 spsk", "2 dl", "knivspids", "dåse").
3. Du skal fjerne valgfrie tilføjelser (f.eks. ændre "smør til stegning" til "smør").
4. Hvis en ingrediens er meget specifik som f.eks. "økologisk mælk", skal du bare returnere "mælk" (vores system filtrerer selv økologi bagefter).
5. Svar KUN med den rå JSON-array. Ingen forklaringer, ingen markdown-blokke (som \`\`\`json). Det skal starte med [ og slutte med ].

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
    const ingredients = JSON.parse(cleanJsonStr);
    
    if (!Array.isArray(ingredients)) {
      throw new Error("LLM returnerede ikke et JSON array.");
    }
    
    res.json({
      url,
      ingredients: ingredients.map(i => i.trim()).filter(Boolean)
    });
    
  } catch (err) {
    console.error(`[Recipe Scan] Error scanning recipe:`, err);
    res.status(500).json({ error: `Opskrift-scanning mislykkedes: ${err.message}` });
  }
});

// 3. Search and aggregate prices for a list of ingredients
app.post('/api/recipe/prices', async (req, res) => {
  const { ingredients } = req.body;
  
  if (!ingredients || !Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: "Ingredienser skal angives som et array" });
  }
  
  console.log(`[Recipe Prices] Beginning aggregate search for: ${ingredients.join(', ')}`);
  
  // Re-use internal API search logic
  const searchForIngredient = async (ingredient) => {
    // Check cache first
    const cached = getCachedSearch(ingredient);
    if (cached) {
      console.log(`[Recipe Prices] Cache hit for "${ingredient}"`);
      return cached;
    }
    
    try {
      // 1. Fetch Nemlig
      await nemligSession.ensureSession();
      const nemligParams = new URLSearchParams({
        query: ingredient,
        take: "25",
        skip: "0",
        recipeCount: "0",
        timestamp: nemligSession.timestamp,
        timeslotUtc: nemligSession.timeslotUtc,
        deliveryZoneId: nemligSession.deliveryZoneId
      });
      
      let nemligRes = await fetch(`${NEMLIG_SEARCH_URL}/searchgateway/api/search?${nemligParams}`, {
        headers: {
          ...NEMLIG_DEFAULT_HEADERS,
          "X-Correlation-Id": crypto.randomUUID(),
          "Authorization": `Bearer ${nemligSession.bearerToken}`
        }
      });
      
      if (nemligRes.status === 401) {
        nemligSession.invalidateSession();
        await nemligSession.ensureSession();
        nemligRes = await fetch(`${NEMLIG_SEARCH_URL}/searchgateway/api/search?${nemligParams}`, {
          headers: {
            ...NEMLIG_DEFAULT_HEADERS,
            "X-Correlation-Id": crypto.randomUUID(),
            "Authorization": `Bearer ${nemligSession.bearerToken}`
          }
        });
      }
      
      const nemligData = await nemligRes.json();
      const nemligItems = (nemligData.Products?.Products || []).map(parseNemligProduct);
      
      // 2. Fetch Tjek
      const tjekParams = new URLSearchParams({
        query: ingredient,
        country_id: "DK",
        limit: "40"
      });
      const tjekRes = await fetch(`https://api.etilbudsavis.dk/v2/offers/search?${tjekParams}`, {
        headers: { 'User-Agent': 'grocery-aggregator/1.0' }
      });
      
      const tjekData = await tjekRes.json();
      const tjekItems = tjekData.map(parseTjekProduct);
      
      const combined = [...nemligItems, ...tjekItems];
      
      // Sort cheapest first
      combined.sort((a, b) => {
        if (a.price === null) return 1;
        if (b.price === null) return -1;
        return a.price - b.price;
      });
      
      setCachedSearch(ingredient, combined);
      return combined;
    } catch (err) {
      console.error(`[Recipe Prices] Search failed for "${ingredient}":`, err.message);
      return [];
    }
  };
  
  try {
    // Generate tasks for the rate-limiter
    const tasks = ingredients.map(ing => () => searchForIngredient(ing).then(results => ({
      ingredient: ing,
      results
    })));
    
    // Run search tasks with max 3 concurrent requests to avoid rate limits
    const searchResults = await limitParallel(tasks, 3);
    
    const aggregated = searchResults.map(({ ingredient, results }) => {
      const withPrice = results.filter(r => r.price !== null);
      
      const bestMatch = withPrice[0] || null;
      const organicOption = withPrice.find(r => r.isOrganic) || null;
      
      return {
        ingredient,
        bestMatch,
        organicOption,
        alternatives: withPrice.slice(0, 5) // top 5 alternatives
      };
    });
    
    // Calculate recommended store (the store that can deliver most of the ingredients)
    const storeCount = {};
    let matchedCount = 0;
    
    aggregated.forEach(item => {
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
    
    const totalEstimate = aggregated.reduce((acc, item) => acc + (item.bestMatch?.price || 0), 0);
    const organicTotalEstimate = aggregated.reduce((acc, item) => {
      const match = item.organicOption || item.bestMatch;
      return acc + (match?.price || 0);
    }, 0);
    
    res.json({
      ingredients: aggregated,
      summary: {
        totalEstimate: parseFloat(totalEstimate.toFixed(2)),
        organicTotalEstimate: parseFloat(organicTotalEstimate.toFixed(2)),
        matchedCount,
        totalCount: ingredients.length,
        recommendedStore,
        storeMatches: maxMatches
      }
    });
    
  } catch (error) {
    console.error("[Recipe Prices] Processing error:", error);
    res.status(500).json({ error: "Fejl under prissammenligning for opskriften." });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(` Dansk Indkøbssøgemaskine running on port ${PORT}`);
  console.log(` Open http://localhost:${PORT} in your browser`);
  console.log(`==================================================`);
});
