/* ==========================================================
   PrisJagt - Shopping list parsing

   Offline (heuristic) parser + LLM prompt/normalizer. The heuristic
   parser is always available, so list search works without an LLM.
   ========================================================== */

const QTY_UNITS = [
  'kg', 'g', 'l', 'liter', 'liter', 'dl', 'cl', 'ml',
  'stk', 'styks', 'pk', 'ps', 'pakke', 'pakker', 'pose', 'poser',
  'glas', 'bundt', 'bundter', 'dåse', 'dåser', 'fed', 'hele', 'ca'
].join('|');

const NOISE_ITEMS = new Set([
  'andet', 'diverse', 'evt', 'eventuelt', 'øvrigt', 'osv', 'etc',
  'ukendt', 'various', 'and', 'eller'
]);

const SINGULAR_MAP = {
  'avocadoer': 'avocado',
  'avocado': 'avocado',
  'bananer': 'banan',
  'tomater': 'tomat',
  'tomaterne': 'tomat',
  'citroner': 'citron',
  'clementiner': 'clementin',
  'æbler': 'æble',
  'druer': 'drue',
  'vindruer': 'vindrue',
  'svampe': 'svamp',
  'agurker': 'agurk',
  'peberfrugter': 'peberfrugt',
  'gulerødder': 'gulerod',
  'pølser': 'pølse',
  'spegepølser': 'spegepølse',
  'bær': 'bær',
  'rejer': 'rejer',
  'æg': 'æg',
  'løg': 'løg',
  'lime': 'lime',
  'nudler': 'nudler',
  'kerner': 'kerner'
};

// Common Danish products where the name alone is ambiguous. These variants
// give the user concrete choices even when no LLM is configured.
const AMBIGUOUS_PRODUCTS = {
  'appelsinjuice': [
    { label: 'Økologisk', searchQuery: 'økologisk appelsinjuice' },
    { label: 'Koncentrat', searchQuery: 'appelsinjuice koncentrat' },
    { label: 'Direkte presset', searchQuery: 'direkte presset appelsinjuice' }
  ],
  'æblejuice': [
    { label: 'Økologisk', searchQuery: 'økologisk æblejuice' },
    { label: 'Koncentrat', searchQuery: 'æblejuice koncentrat' },
    { label: 'Direkte presset', searchQuery: 'direkte presset æblejuice' }
  ],
  'mælk': [
    { label: 'Letmælk', searchQuery: 'letmælk' },
    { label: 'Minimælk', searchQuery: 'minimælk' },
    { label: 'Sødmælk', searchQuery: 'sødmælk' },
    { label: 'Økologisk', searchQuery: 'økologisk mælk' }
  ],
  'yoghurt': [
    { label: 'Naturel', searchQuery: 'yoghurt naturel' },
    { label: 'Økologisk', searchQuery: 'økologisk yoghurt' },
    { label: 'Skyr', searchQuery: 'skyr' }
  ],
  'øl': [
    { label: 'Pilsner', searchQuery: 'pilsner øl' },
    { label: 'Alkoholfri', searchQuery: 'alkoholfri øl' },
    { label: 'Økologisk', searchQuery: 'økologisk øl' }
  ],
  'kaffebønner': [
    { label: 'Espresso', searchQuery: 'espresso kaffebønner' },
    { label: 'Filter', searchQuery: 'filter kaffebønner' },
    { label: 'Økologisk', searchQuery: 'økologiske kaffebønner' }
  ]
};

const CATEGORY_KEYWORDS = [
  ['mejeri', ['mælk', 'yoghurt', 'skyr', 'smør', 'ost', 'mozzarella', 'parmesan', 'fløde', 'creme fraiche', 'kvark']],
  ['fisk', ['laks', 'rejer', 'fisk', 'tun', 'torsk', 'røget']],
  ['kød', ['bacon', 'pølse', 'pølser', 'spegepølse', 'oksekød', 'svinekød', 'kylling', 'hakket', 'kød']],
  ['grønt', ['æble', 'æbler', 'banan', 'bananer', 'agurk', 'tomat', 'tomater', 'clementin', 'drue', 'avocado', 'citron', 'lime', 'salat', 'romaine', 'rucola', 'pak choi', 'koriander', 'forårsløg', 'hvidløg', 'svamp', 'svampe', 'bær', 'peberfrugt', 'maj']],
  ['brød', ['brød', 'rugkerner', 'havregryn', 'gnocchi', 'ramen', 'nudler', 'pasta']],
  ['drikkevarer', ['juice', 'saft', 'kaffe', 'øl', 'vand', 'sodavand', 'te']],
  ['frost', ['frosne', 'frost', 'ispind', 'isvand', 'frozen']],
  ['tørvarer', ['mel', 'gær', 'sukker', 'olie', 'ris', 'passata', 'marmelade', 'pinjekerner', 'solsikke', 'hør frø', 'rosiner', 'kakao']],
  ['konserves', ['dåse', 'konserves']],
  ['krydderier', ['salt', 'peber', 'krydderi']]
];

export function inferCategory(text) {
  const lower = String(text || '').toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return 'andet';
}

export function fallbackQueriesFor(name) {
  const queries = [];
  const lower = String(name || '').toLowerCase().trim();
  const singular = SINGULAR_MAP[lower];
  if (singular && singular !== lower) queries.push(singular);

  // Common Danish synonyms that catalogs often use instead of the spoken word.
  const SYNONYMS = {
    'vindruer': ['druer'],
    'vindrue': ['druer'],
    'druer': ['vindruer']
  };
  for (const synonym of SYNONYMS[lower] || []) queries.push(synonym);

  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length >= 3) queries.push(words.slice(-2).join(' '));

  // "Snack peberfrugter" should also be searched as "peberfrugter" when the
  // descriptive first word is throwing off the catalog search.
  const head = words[words.length - 1] || '';
  if (words.length >= 2 && SINGULAR_MAP[head] && SINGULAR_MAP[head] !== head) {
    queries.push(words.slice(0, -1).concat(SINGULAR_MAP[head]).join(' '));
    queries.push(SINGULAR_MAP[head]);
  }

  // Long Danish plurals/compounds: "morgenmadspølser" -> "morgenmadspølse"/"pølser".
  if (head.length >= 9 && /er$/.test(head)) queries.push(words.slice(0, -1).concat(head.slice(0, -1)).join(' '));
  if (head.length >= 10 && /e$/.test(head)) queries.push(words.slice(0, -1).concat(head.slice(0, -1)).join(' '));
  const COMPOUND_TAILS = ['pølser', 'nudler', 'kerner', 'bær', 'juice', 'kød', 'mel', 'brød'];
  for (const tail of COMPOUND_TAILS) {
    if (head.endsWith(tail) && head.length > tail.length + 2) queries.push(tail);
  }

  return [...new Set(queries)].slice(0, 3);
}

// Split on commas, but never inside decimal numbers such as "1,6-2 kg".
function splitOnCommaOutsideNumbers(str) {
  const parts = [];
  let current = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const prev = str[i - 1] || '';
    const next = str[i + 1] || '';
    if (ch === ',' && !/\d/.test(prev) && !/\d/.test(next)) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

// Remove leading quantities/units ("2 ps 5 kg", "1,6-2 kg", "14 hele", ...)
// while keeping descriptive words ("frisk", "røget", "frosne", ...).
function stripQuantities(segment) {
  const hints = [];
  let s = String(segment || '');

  const parens = [...s.matchAll(/\(([^)]*)\)/g)].map(m => m[1].trim()).filter(Boolean);
  if (parens.length) {
    hints.push(... parens);
    s = s.replace(/\([^)]*\)/g, ' ');
  }

  s = s.replace(/^\s*(?:[-•*–—]|\d+[.)])\s*/, '');
  s = s.replace(/^\s*(?:evt\.?|eventuelt)\s+/i, ' ');
  s = s.replace(/^\s*(?:frugt|grønt|grøntsager|kød|mejeri|drikkevarer|frost)\s*:\s*/i, ' ');

  const qtyRe = new RegExp(
    `^\\s*\\d+(?:[.,]\\d+)?(?:\\s*[-–]\\s*\\d+(?:[.,]\\d+)?)?\\s*(?:${QTY_UNITS})?\\b\\s*`,
    'i'
  );
  let previous;
  do {
    previous = s;
    s = s.replace(qtyRe, ' ');
  } while (s !== previous);

  // Quantities can also be written after the item ("solsikke kerner 800 g").
  const trailingQtyRe = new RegExp(
    `\\s*\\d+(?:[.,]\\d+)?(?:\\s*[-–]\\s*\\d+(?:[.,]\\d+)?)?\\s*(?:${QTY_UNITS})?\\s*$`,
    'i'
  );
  s = s.replace(trailingQtyRe, ' ');

  // Stray leading number without a recognised unit.
  s = s.replace(/^\s*\d+(?:[.,]\d+)?\s+/, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return { text: s, hint: hints.join(', ') };
}

function makeItem(name, extra = {}) {
  const cleanName = String(name || '').replace(/\s+/g, ' ').trim();
  return {
    name: cleanName,
    searchQuery: extra.searchQuery || cleanName,
    category: extra.category || inferCategory(cleanName),
    excludeTerms: Array.isArray(extra.excludeTerms) ? extra.excludeTerms : [],
    alternatives: Array.isArray(extra.alternatives) ? extra.alternatives : [],
    question: extra.question || null,
    note: extra.note || '',
    fallbackQueries: extra.fallbackQueries || fallbackQueriesFor(cleanName),
    amount: extra.amount ?? null,
    unit: extra.unit ?? null
  };
}

/**
 * Parse a pasted shopping list without any AI.
 * Quantities are ignored; "eller" and comma-separated groups become
 * alternative search queries rather than being dropped.
 */
export function parseShoppingListHeuristic(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];

  for (const line of lines) {
    for (const rawSegment of splitOnCommaOutsideNumbers(line)) {
      const { text: cleaned, hint } = stripQuantities(rawSegment);
      if (!cleaned || cleaned.length < 2) continue;
      if (NOISE_ITEMS.has(cleaned.toLowerCase())) continue;

      // "yoghurt eller skyr" -> primary + explicit alternatives
      const parts = cleaned.split(/\s+eller\s+/i).map(p => p.trim()).filter(Boolean);
      const primary = parts[0];
      const alternatives = parts.slice(1).map(alt => ({
        label: alt,
        searchQuery: alt
      }));

      if (NOISE_ITEMS.has(primary.toLowerCase())) continue;

      const predefined = AMBIGUOUS_PRODUCTS[primary.toLowerCase()] || [];
      const allAlternatives = [...alternatives, ...predefined]
        .filter((alt, idx, arr) => arr.findIndex(a => a.searchQuery === alt.searchQuery) === idx)
        .slice(0, 8);

      items.push(makeItem(primary, {
        alternatives: allAlternatives,
        question: alternatives.length
          ? `Mener du "${primary}" eller en af alternativerne?`
          : predefined.length
            ? `Hvilken type ${primary} leder du efter?`
            : null,
        note: hint
      }));
    }
  }

  return items.slice(0, 200);
}

/** Prompt used when the user opts into LLM-assisted parsing. */
export function buildListParsePrompt(text) {
  return `Du er en dansk indkøbsassistent. Analysér teksten nedenfor: det er en indkøbsliste, ofte med mængder, pakningstyper og punkttegn.

Returnér en JSON-array af objekter med præcis disse felter:
- "name": Varens navn på dansk. MÆNGDER, ANTAL, VÆGT, VOLUMEN, PRISER og pakningstyper (pk, ps, pose, glas, bundt ...) skal IGNORERES fuldstændigt. Bevar form/tilstand som "frisk", "frossen", "røget", "grovvalsede" hvis den er vigtig.
- "searchQuery": Kort søgestreng til en dansk supermarkedssøgemaskine. Ingen mængder. Brug dalens almindelige stavemåde, f.eks. "havregryn", "hvedemel", "appelsinjuice".
- "category": Én af: "kød", "fisk", "mejeri", "grønt", "tørvarer", "brød", "konserves", "krydderier", "frost", "drikkevarer", "andet".
- "excludeTerms": JSON-array af ord der IKKE må stå i produktnavnet, hvis der er risiko for forveksling (f.eks. "pålæg" for frisk kylling, "creme" for mælk). Tom array [] hvis ikke nødvendigt.
- "alternatives": JSON-array af objekter med "label" og "searchQuery". Brug dette når varen kan betyde flere forskellige typer, eller når teksten siger "eller". Eksempel for "appelsinjuice": [{"label":"Økologisk","searchQuery":"økologisk appelsinjuice"},{"label":"Koncentrat","searchQuery":"appelsinjuice koncentrat"},{"label":"Direkte presset","searchQuery":"direkte presset appelsinjuice"}]. Tom array hvis entydig.
- "question": Et kort opfølgende spørgsmål på dansk, hvis alternativerne kræver brugerens valg (f.eks. "Hvilken type appelsinjuice?"). Ellers null.
- "note": Kort dansk note hvis teksten var uklar (f.eks. "mængde ignoreret"), ellers "".

Regler:
1. Del linjer med flere varer op (kommasepareret eller "FRUGT: æbler, clementiner, vindruer").
2. Ignorer ord som "andet", "diverse", "evt." når de ikke er en vare.
3. Returner KUN den rå JSON-array. Ingen markdown, ingen forklaringer.
4. Medtag højst 200 varer.

Indkøbsliste:
${text}`;
}

/** Find a balanced JSON array, ignoring brackets inside strings. */
function findBalancedArray(raw) {
  const start = raw.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

/**
 * Repair the most common LLM JSON slips: smart quotes, trailing commas, raw
 * line breaks inside strings and unescaped quotes inside a string value.
 */
function repairJsonArray(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') {
        // A quote followed by more text is almost certainly meant to be
        // literal inside the value ("Hvilken "type" vil du?").
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        if (next && !',}:]'.includes(next)) out += '\\"';
        else { out += ch; inString = false; }
        continue;
      }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }

  // Trailing commas are invalid JSON but very common in model output.
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** Extract a JSON array from an LLM reply (tolerates markdown and small slips). */
export function extractJsonArray(responseText) {
  let raw = String(responseText || '').trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  }
  raw = raw.replace(/[“”„]/g, '"').replace(/[‘’]/g, "'");

  // Sanitize before locating the array so unescaped quotes can't hide the
  // closing bracket from the balanced-array scanner.
  const sanitized = repairJsonArray(raw);
  const bounds = findBalancedArray(sanitized);
  if (!bounds) throw new Error('LLM returnerede ikke en JSON-array.');
  const candidate = sanitized.slice(bounds.start, bounds.end);

  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed)) throw new Error('LLM returnerede ikke en JSON-array.');
    return parsed;
  } catch (firstError) {
    try {
      const parsed = JSON.parse(repairJsonArray(candidate));
      if (!Array.isArray(parsed)) throw new Error('LLM returnerede ikke en JSON-array.');
      return parsed;
    } catch (repairError) {
      console.warn('[List Parse] Kunne ikke reparere LLM JSON:', repairError.message, 'uddrag:', candidate.slice(0, 300));
      throw new Error(`LLM returnerede ugyldig JSON (${repairError.message}).`);
    }
  }
}

/** Normalise items coming from LLM, heuristic parser or the client. */
export function normalizeParsedItems(rawItems, max = 200) {
  if (!Array.isArray(rawItems)) return [];
  const items = [];

  for (const raw of rawItems) {
    if (items.length >= max) break;

    if (typeof raw === 'string') {
      const name = raw.trim();
      if (name) items.push(makeItem(name));
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;

    const name = String(raw.name || '').replace(/\s+/g, ' ').trim();
    const searchQuery = String(raw.searchQuery || name).replace(/\s+/g, ' ').trim();
    if (!name || !searchQuery) continue;

    const alternatives = (Array.isArray(raw.alternatives) ? raw.alternatives : [])
      .map(alt => {
        if (typeof alt === 'string') {
          return { label: alt.trim(), searchQuery: alt.trim() };
        }
        const label = String(alt?.label || alt?.name || '').trim();
        const query = String(alt?.searchQuery || label).trim();
        return label && query ? { label, searchQuery: query } : null;
      })
      .filter(Boolean)
      .slice(0, 8);

    items.push({
      id: raw.id ? String(raw.id) : `item-${items.length + 1}`,
      name,
      searchQuery,
      category: String(raw.category || inferCategory(name)).trim() || 'andet',
      excludeTerms: Array.isArray(raw.excludeTerms)
        ? raw.excludeTerms.map(t => String(t).toLowerCase()).filter(Boolean)
        : [],
      alternatives,
      question: raw.question ? String(raw.question).trim() : null,
      note: raw.note ? String(raw.note).trim() : '',
      fallbackQueries: Array.isArray(raw.fallbackQueries)
        ? raw.fallbackQueries.map(q => String(q).trim()).filter(Boolean).slice(0, 3)
        : fallbackQueriesFor(name),
      amount: raw.amount != null && !Number.isNaN(Number(raw.amount)) ? Number(raw.amount) : null,
      unit: raw.unit ? String(raw.unit) : null
    });
  }

  return items;
}
