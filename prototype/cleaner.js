// normalize-cocktails.mjs
import fs from "node:fs/promises";

const FRACTION_MAP = {
  "½": "1/2",
  "¼": "1/4",
  "¾": "3/4",
  "⅓": "1/3",
  "⅔": "2/3",
  "⅛": "1/8",
};

const UNIT_ALIASES = new Map([
  ["oz", "oz"],
  ["ounce", "oz"],
  ["ounces", "oz"],
  ["ml", "ml"],
  ["milliliter", "ml"],
  ["milliliters", "ml"],
  ["cl", "cl"],
  ["l", "l"],
  ["tsp", "tsp"],
  ["teaspoon", "tsp"],
  ["teaspoons", "tsp"],
  ["tblsp", "tbsp"],
  ["tbsp", "tbsp"],
  ["tablespoon", "tbsp"],
  ["tablespoons", "tbsp"],
  ["dash", "dash"],
  ["dashes", "dash"],
  ["drop", "drop"],
  ["drops", "drop"],
  ["part", "part"],
  ["parts", "part"],
  ["shot", "shot"],
  ["shots", "shot"],
  ["bar spoon", "barspoon"],
  ["bar spoons", "barspoon"],
  ["barspoon", "barspoon"],
  ["barspoons", "barspoon"],
  ["scoop", "scoop"],
  ["scoops", "scoop"],
  ["handful", "handful"],
  ["wedge", "wedge"],
  ["wedges", "wedge"],
  ["slice", "slice"],
  ["slices", "slice"],
  ["sprig", "sprig"],
  ["sprigs", "sprig"],
  ["cube", "cube"],
  ["cubes", "cube"],
  ["twist", "twist"],
  ["twists", "twist"],
  ["pinch", "pinch"],
  ["fifth", "fifth"],
  ["pint", "pint"],
]);

const GARNISH_HINTS = [
  "cherry",
  "lemon peel",
  "orange peel",
  "lime peel",
  "twist of lemon peel",
  "twist of orange peel",
  "lemon twist",
  "orange twist",
  "mint",
  "mint sprig",
  "nutmeg",
  "orange zest",
  "lemon zest",
];

const NORMALIZATION_RULES = [
  [/^fresh(ly)? squeezed /, ""],
  [/^fresh /, ""],
  [/^juice of /, ""],
  [/^red sweet vermouth$/, "sweet vermouth"],
  [/^sweet red vermouth$/, "sweet vermouth"],
  [/^white cuban ron$/, "white rum"],
  [/^white rum$/, "white rum"],
  [/^light rum$/, "white rum"],
  [/^jamaican dark rum$/, "dark rum"],
  [/^tequila 100% agave$/, "tequila"],
  [/^baileys irish cream$/, "irish cream liqueur"],
  [/^irish cream$/, "irish cream liqueur"],
  [/^creme de mure$/, "crème de mûre"],
  [/^sugar syrup$/, "simple syrup"],
  [/^powdered sugar$/, "sugar"],
];

function normalizeWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

function replaceUnicodeFractions(s) {
  let out = s;
  for (const [k, v] of Object.entries(FRACTION_MAP)) {
    out = out.replaceAll(k, v);
  }
  return out;
}

function parseNumberToken(token) {
  token = token.trim();

  if (/^\d+\s+\d+\/\d+$/.test(token)) {
    const [whole, frac] = token.split(/\s+/);
    const [n, d] = frac.split("/");
    return Number(whole) + Number(n) / Number(d);
  }

  if (/^\d+\/\d+$/.test(token)) {
    const [n, d] = token.split("/");
    return Number(n) / Number(d);
  }

  if (/^\d+(\.\d+)?$/.test(token)) {
    return Number(token);
  }

  return null;
}

function extractLeadingAmount(s) {
  const patterns = [
    /^(\d+\s+\d+\/\d+)\b/,
    /^(\d+\/\d+)\b/,
    /^(\d+(\.\d+)?)\b/,
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      return {
        amount: parseNumberToken(m[1]),
        rest: s.slice(m[0].length).trim(),
      };
    }
  }

  return { amount: null, rest: s.trim() };
}

function extractUnit(s) {
  const keys = [...UNIT_ALIASES.keys()].sort((a, b) => b.length - a.length);
  const lower = s.toLowerCase();

  for (const key of keys) {
    if (lower === key || lower.startsWith(`${key} `)) {
      return {
        unit: UNIT_ALIASES.get(key),
        rest: s.slice(key.length).trim(),
      };
    }
  }

  return { unit: null, rest: s.trim() };
}

function parseIngredientRaw(raw) {
  let s = normalizeWhitespace(replaceUnicodeFractions(raw));
  const original = s;
  const qualifiers = [];

  if (/optional/i.test(s)) qualifiers.push("optional");
  if (/to taste/i.test(s)) qualifiers.push("to_taste");
  if (/top up/i.test(s)) qualifiers.push("top_up");
  if (/fill with/i.test(s)) qualifiers.push("fill");
  if (/few drops?/i.test(s)) qualifiers.push("few");
  if (/pinch/i.test(s)) qualifiers.push("pinch");

  // strip parentheticals late enough to detect optional
  s = s.replace(/\([^)]*\)/g, "").trim();

  // special phrases
  if (/^top up /i.test(s)) {
    return {
      raw: original,
      amount: null,
      unit: null,
      ingredient: normalizeIngredientName(s.replace(/^top up /i, "")),
      qualifiers: [...qualifiers, "top_up"],
      confidence: "medium",
    };
  }

  if (/^fill with /i.test(s)) {
    return {
      raw: original,
      amount: null,
      unit: null,
      ingredient: normalizeIngredientName(s.replace(/^fill with /i, "")),
      qualifiers: [...qualifiers, "fill"],
      confidence: "medium",
    };
  }

  if (/^few drops? of /i.test(s)) {
    return {
      raw: original,
      amount: null,
      unit: "drop",
      ingredient: normalizeIngredientName(s.replace(/^few drops? of /i, "")),
      qualifiers: [...qualifiers, "few"],
      confidence: "medium",
    };
  }

  if (/^(a|an) pinch of /i.test(s)) {
    return {
      raw: original,
      amount: 1,
      unit: "pinch",
      ingredient: normalizeIngredientName(s.replace(/^(a|an) pinch of /i, "")),
      qualifiers,
      confidence: "medium",
    };
  }

  const { amount, rest: afterAmount } = extractLeadingAmount(s);
  const { unit, rest: afterUnit } = extractUnit(afterAmount);

  let ingredient = afterUnit || afterAmount || s;

  // repair common stray prefixes
  ingredient = ingredient
    .replace(/^of /i, "")
    .replace(/^fresh /i, "fresh ")
    .trim();

  return {
    raw: original,
    amount,
    unit,
    ingredient: normalizeIngredientName(ingredient),
    qualifiers,
    confidence: amount !== null || unit !== null ? "high" : "low",
  };
}

function normalizeIngredientName(name) {
  let s = normalizeWhitespace(name.toLowerCase());

  for (const [re, replacement] of NORMALIZATION_RULES) {
    s = s.replace(re, replacement);
  }

  s = s
    .replace(/^of /, "")
    .replace(/\bwhite\b(?=\s+egg$)/, "")
    .replace(/^egg white$/, "egg white")
    .replace(/^maraschino cherry$/, "cherry")
    .replace(/^cherry$/, "cherry")
    .replace(/^club soda$/, "soda water")
    .replace(/^soda$/, "soda water");

  return normalizeWhitespace(s);
}

function inferRole(ingredient, qualifiers = []) {
  const s = ingredient.toLowerCase();

  if (GARNISH_HINTS.some((g) => s.includes(g))) return "garnish";
  if (s.includes("bitters")) return "bittering_agent";
  if (s.includes("vermouth")) return "fortified_wine";
  if (s.includes("soda water") || s.includes("tonic") || s.includes("prosecco") || s.includes("champagne")) return "effervescence";
  if (s.includes("juice") || s === "lime" || s === "lemon") {
    if (s.includes("lemon juice") || s.includes("lime juice") || s.includes("grapefruit juice")) return "acid";
    return "juice";
  }
  if (s.includes("syrup") || s === "sugar" || s === "grenadine" || s === "honey" || s === "agave") return "sweetener";
  if (s.includes("cream") || s.includes("milk") || s.includes("ice-cream")) return "dairy";
  if (s.includes("egg white") || s === "egg") return "egg";
  if (
    s.includes("rum") || s.includes("gin") || s.includes("vodka") || s.includes("tequila") ||
    s.includes("mezcal") || s.includes("whiskey") || s.includes("whisky") ||
    s.includes("bourbon") || s.includes("rye") || s.includes("scotch") ||
    s.includes("brandy") || s.includes("cognac") || s.includes("applejack") ||
    s.includes("cachaça") || s.includes("cachaca")
  ) return "base_spirit";
  if (
    s.includes("liqueur") || s.includes("triple sec") || s.includes("curaçao") ||
    s.includes("curacao") || s.includes("chartreuse") || s.includes("maraschino") ||
    s.includes("falernum") || s.includes("benedictine") || s.includes("amaretto") ||
    s.includes("campari") || s.includes("aperol") || s.includes("kahlua") ||
    s.includes("sambuca")
  ) return "liqueur_modifier";

  if (qualifiers.includes("top_up") || qualifiers.includes("fill")) return "effervescence";

  return "other";
}

function shouldMoveToGarnish(parsed) {
  if (!parsed.ingredient) return false;
  const role = inferRole(parsed.ingredient, parsed.qualifiers);
  if (role !== "garnish") return false;

  // keep mint as garnish only if tiny non-liquid quantity
  if (parsed.ingredient === "mint" && parsed.amount && parsed.unit === "handful") return false;

  return true;
}

function canonicalizeTags(tags = []) {
  return [...new Set(tags.map(t => t.trim().toLowerCase().replace(/\s+/g, "_")))];
}

function mergeCocktailRecords(records) {
  // prefer IBA as canonical for overlapping names
  const sorted = [...records].sort((a, b) => {
    const score = (r) => (r.source === "iba" ? 2 : 1);
    return score(b) - score(a);
  });

  const primary = structuredClone(sorted[0]);
  primary.source_records = sorted.map(r => ({
    source: r.source,
    source_id: r.id,
    source_url: r.source_url,
  }));

  primary.tags = canonicalizeTags(sorted.flatMap(r => r.tags || []));

  return primary;
}

function normalizeCocktail(c) {
  const ingredients = [];
  const garnish = [];

  for (const ing of c.ingredients || []) {
    const parsed = parseIngredientRaw(ing.raw || ing.ingredient || "");
    parsed.role = inferRole(parsed.ingredient, parsed.qualifiers);

    if (shouldMoveToGarnish(parsed)) {
      garnish.push(parsed);
    } else {
      ingredients.push(parsed);
    }
  }

  return {
    id: c.id,
    source: c.source,
    name: normalizeWhitespace(c.name),
    name_key: normalizeWhitespace(c.name).toLowerCase(),
    category: c.category ? normalizeWhitespace(c.category) : null,
    ingredients,
    garnish,
    method: c.method ? normalizeWhitespace(c.method) : null,
    glass: c.glass ? normalizeWhitespace(c.glass).toLowerCase() : null,
    image_url: c.image_url || null,
    tags: canonicalizeTags(c.tags || []),
    source_url: c.source_url,
  };
}

async function main() {
  const raw = JSON.parse(await fs.readFile("cocktails_raw.json", "utf8"));
  const normalized = raw.map(normalizeCocktail);

  const byName = new Map();

  for (const c of normalized) {
    const key = c.name_key;
    const arr = byName.get(key) || [];
    arr.push(c);
    byName.set(key, arr);
  }

  const merged = [...byName.values()].map(mergeCocktailRecords);

  await fs.writeFile("cocktails_normalized.json", JSON.stringify(merged, null, 2));
  console.log(`raw: ${raw.length}`);
  console.log(`normalized merged: ${merged.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
