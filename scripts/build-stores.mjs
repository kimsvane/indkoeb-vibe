#!/usr/bin/env node
/*
 * Bygger lib/stores.json med koordinater for danske dagligvarekæder.
 * Data hentes fra OpenStreetMap via Overpass API (offentlig open data, ODbL).
 *
 * Kør:  node scripts/build-stores.mjs
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'lib', 'stores.json');

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

const UA = 'PrisJagt-store-builder/1.0 (+https://github.com/kimsvane/indkoeb-vibe)';

// Chain -> brand/operator/name regex used both for the query and for bucketing.
const CHAIN_BRANDS = {
  'REMA 1000':   'REMA 1000',
  'Netto':       'Netto',
  'Føtex':       'Føtex',
  'Bilka':       'Bilka',
  'Lidl':        'Lidl',
  'Meny':        'Meny',
  'Spar':        'SPAR|Spar',
  'SuperBrugsen':'SuperBrugsen',
  'Brugsen':     'Brugsen',
  'Kvickly':     'Kvickly',
  'Coop 365':    '365discount|365 discount|Coop 365|\\b365\\b',
  'Fakta':       'Fakta',
  'Aldi':        'Aldi',
  'Joker':       'Joker',
  'ABC Lavpris': 'ABC Lavpris',
  'Kiwi':        'Kiwi',
  'Min Købmand': 'Min Købmand|Mini Købmand',
  'Letkøb':      'Letkøb',
  'Coop':        'Coop',
  'Coop Mega':   'Coop Mega|Mega',
  'Coop Extra':  'Coop Extra|Extra',
};

// Dealer-navne (som de ses i Tjek-resultaterne) -> kæde-key
const ALIASES = {
  'rema': 'REMA 1000',
  'rema1000': 'REMA 1000',
  'rema 1000': 'REMA 1000',
  'netto': 'Netto',
  'føtex': 'Føtex',
  'foetex': 'Føtex',
  'bilka': 'Bilka',
  'lidl': 'Lidl',
  'meny': 'Meny',
  'spar': 'Spar',
  'spar butikker': 'Spar',
  'superbrugsen': 'SuperBrugsen',
  'brugsen': 'Brugsen',
  'coop brugsen': 'Brugsen',
  "dagli'brugsen": 'Brugsen',
  'kvickly': 'Kvickly',
  'kvickly xtra': 'Kvickly',
  '365': 'Coop 365',
  '365discount': 'Coop 365',
  '365 discount': 'Coop 365',
  'coop 365': 'Coop 365',
  'fakta': 'Fakta',
  'aldi': 'Aldi',
  'joker': 'Joker',
  'abc lavpris': 'ABC Lavpris',
  'abc-lavpris': 'ABC Lavpris',
  'abclavpris': 'ABC Lavpris',
  'kiwi': 'Kiwi',
  'kiwi min købmand': 'Min Købmand',
  'min købmand': 'Min Købmand',
  'letkøb': 'Letkøb',
  'coop': 'Coop',
  'coop mega': 'Coop Mega',
  'coop extra': 'Coop Extra',
  'extra': 'Coop Extra',
};

const SHOP_FILTER = '"shop"~"supermarket|discount"';

function buildQuery(brandRegexes, useName = false) {
  const brandClause = `nwr["brand"~"${brandRegexes}",i][${SHOP_FILTER}](area.dk);`;
  const nameClause = useName ? `nwr["name"~"${brandRegexes}",i][${SHOP_FILTER}](area.dk);` : '';
  return `[out:json][timeout:45];
area["ISO3166-1"="DK"][admin_level=2]->.dk;
(
${brandClause}${nameClause ? '\n' + nameClause : ''}
);
out center 5000;`;
}

async function queryOverpass(brandRegexes, retries = 3, useName = false) {
  const body = buildQuery(brandRegexes, useName);
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const mirror of OVERPASS_MIRRORS) {
      for (let rl = 0; rl < 2; rl++) {
        try {
          const args = [
            '-s', '-m', '45', '-G',
            '--data-urlencode', `data=${body}`,
            '-H', `User-Agent: ${UA}`,
            '-w', '\n__HTTP__%{http_code}',
            mirror
          ];
          const stdout = execFileSync('curl', args, { encoding: 'utf8', timeout: 50000, maxBuffer: 64 * 1024 * 1024 });
          const [payload, statusLine] = stdout.split('\n__HTTP__');
          const status = parseInt(statusLine || '0', 10);
          if (status === 429) {
            lastErr = new Error(`${mirror} rate-limited (429)`);
            await new Promise(r => setTimeout(r, 12000));
            continue;
          }
          if (status !== 200) {
            lastErr = new Error(`${mirror} HTTP ${status}`);
            break;
          }
          const data = JSON.parse(payload);
          if (data.elements) return data.elements;
          lastErr = new Error(`${mirror} ingen elements`);
        } catch (err) {
          lastErr = err;
          break;
        }
      }
    }
    if (attempt < retries - 1) await new Promise(r => setTimeout(r, 15000));
  }
  throw lastErr || new Error('Overpass kunne ikke besvares');
}

// Sortér elementer ned i de kæder hvis brand/operator/name matcher
function bucket(elements) {
  const chains = {};
  const initChain = (key) => { if (!chains[key]) chains[key] = []; };

  for (const [key, brandRegex] of Object.entries(CHAIN_BRANDS)) {
    initChain(key);
  }

  const seen = {};
  const add = (key, e, lat, lon) => {
    const rLat = Math.round(lat * 10000) / 10000;
    const rLon = Math.round(lon * 10000) / 10000;
    const d = `${key}:${rLat},${rLon}`;
    if (seen[d]) return;
    seen[d] = true;
    chains[key].push({ lat: rLat, lon: rLon, name: e.tags?.name || '' });
  };

  for (const e of elements) {
    const lat = e.type === 'node' ? e.lat : e.center?.lat;
    const lon = e.type === 'node' ? e.lon : e.center?.lon;
    if (lat == null || lon == null) continue;

    const text = [
      e.tags?.brand,
      e.tags?.operator,
      e.tags?.name
    ].filter(Boolean).join(' | ');

    for (const [key, brandRegex] of Object.entries(CHAIN_BRANDS)) {
      if (new RegExp(brandRegex, 'i').test(text)) add(key, e, lat, lon);
    }
  }

  for (const key of Object.keys(chains)) {
    chains[key].sort((a, b) => a.lat - b.lat || a.lon - b.lon);
  }
  return chains;
}

const LOW_THRESHOLD = 40;
const START_KEY = process.argv[2] || null;

// Genindlæs allerede gemte resultater, så scriptet kan genoptages.
const chains = {};
if (START_KEY) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    for (const [key, arr] of Object.entries(prev.chains || {})) {
      if (Array.isArray(arr) && arr.length) chains[key] = arr;
    }
    console.log(`Genoptager fra "${START_KEY}" med ${Object.keys(chains).length} kæder i cache.\n`);
  } catch { /* ingen cache */ }
}

function savePartial() {
  const data = {
    generated: new Date().toISOString(),
    source: 'OpenStreetMap via Overpass API (ODbL). Brand/operator/name + shop tags, DK.',
    chains,
    aliases: ALIASES
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');
}

// Én query pr. kæde (brand), da store kombinerede regex-queries timer ud på Overpass.
let started = !START_KEY;
for (const [key, brandRegex] of Object.entries(CHAIN_BRANDS)) {
  if (!started) {
    if (key === START_KEY) started = true;
    else continue;
  }
  if (chains[key]?.length) {
    console.log(`${key.padEnd(14)} ${String(chains[key].length).padStart(5)} butikker (cache)`);
    continue;
  }
  try {
    const elements = await queryOverpass(brandRegex, 3, false);
    chains[key] = bucket(elements)[key] || [];
    if (chains[key].length < LOW_THRESHOLD) {
      // Få brand-taggede butikker -> prøv også name-søgning
      const nameEl = await queryOverpass(brandRegex, 3, true);
      const extra = bucket(nameEl)[key] || [];
      const existing = new Set(chains[key].map(b => `${b.lat},${b.lon}`));
      const fresh = extra.filter(b => !existing.has(`${b.lat},${b.lon}`));
      chains[key] = [...chains[key], ...fresh];
    }
    console.log(`${key.padEnd(14)} ${String(chains[key].length).padStart(5)} butikker`);
  } catch (err) {
    console.log(`${key.padEnd(14)} FEJL: ${err.message}`);
  }
  savePartial();
  await new Promise(r => setTimeout(r, 20000));
}

console.log('');
for (const key of Object.keys(CHAIN_BRANDS)) {
  console.log(`${key.padEnd(14)} ${String(chains[key]?.length || 0).padStart(5)} butikker`);
}
const total = Object.values(chains).reduce((s, c) => s + c.length, 0);
console.log(`\nFærdig! ${Object.keys(chains).length} kæder, ${total} butikker -> ${OUT}`);
