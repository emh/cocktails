// cleanup-pass-2.mjs
import fs from "node:fs/promises";

const INPUT = process.argv[2] || "cocktails_normalized.json";
const OUTPUT = process.argv[3] || "cocktails_cleaned_v2.json";

const EXCLUDE_INGREDIENT_PATTERNS = [
  /oliveueuer/i,
  /\bcup yoghurt\b/i,
];

const REMOVE_AS_SERVING_NOTE_PATTERNS = [
  /^ice$/i,
  /^crushed ice$/i,
  /^rocks$/i,
];

const INGREDIENT_ALIASES = new Map([
  ["carbonated water", { ingredient: "soda water", role: "topper" }],
  ["water", { ingredient: "soda water", role: "topper" }],
  ["top soda water", { ingredient: "soda water", role: "topper" }],
  ["soda water", { ingredient: "soda water", role: "topper" }],
  ["ginger ale", { ingredient: "ginger ale", role: "topper" }],
  ["lemon-lime soda", { ingredient: "lemon-lime soda", role: "topper" }],
  ["coca-cola", { ingredient: "coca-cola", role: "topper" }],
  ["beer", { ingredient: "beer", role: "topper" }],
  ["red wine", { ingredient: "red wine", role: "topper" }],
  ["coffee", { ingredient: "coffee", role: "topper" }],
  ["milk", { ingredient: "milk", role: "topper" }],
  ["orange juice", { ingredient: "orange juice", role: "topper" }],
  ["lemonade", { ingredient: "lemonade", role: "topper" }],
  ["sweet and sour", { ingredient: "sweet and sour mix", role: "topper" }],

  ["vanilla extract", { ingredient: "vanilla extract", role: "addon" }],
  ["salt", { ingredient: "salt", role: "addon" }],
  ["cloves", { ingredient: "cloves", role: "addon" }],
  ["cinnamon", { ingredient: "cinnamon", role: "addon" }],
  ["nutmeg", { ingredient: "nutmeg", role: "addon" }],
  ["whole egg", { ingredient: "egg", role: "addon" }],
  ["whipped cream", { ingredient: "whipped cream", role: "addon" }],
  ["sherbet", { ingredient: "sherbet", role: "addon" }],
  ["absinthe", { ingredient: "absinthe", role: "addon", qualifiers: ["trace"] }],

  ["grand marnier", { ingredient: "orange liqueur", role: "liqueur_modifier" }],
  ["cointreau", { ingredient: "orange liqueur", role: "liqueur_modifier" }],
  ["peach schnapps", { ingredient: "peach liqueur", role: "liqueur_modifier" }],
  ["galliano", { ingredient: "galliano", role: "liqueur_modifier" }],
  ["creme de cassis", { ingredient: "blackcurrant liqueur", role: "liqueur_modifier" }],
  ["crème de cassis", { ingredient: "blackcurrant liqueur", role: "liqueur_modifier" }],
  ["elderflower cordial", { ingredient: "elderflower cordial", role: "addon" }],

  ["crown royal", { ingredient: "whiskey", role: "base_spirit" }],
  ["kahlua", { ingredient: "kahlua", role: "liqueur_modifier" }],
  ["maraschino luxardo", { ingredient: "maraschino liqueur", role: "liqueur_modifier" }],

  ["superfine sugar", { ingredient: "simple syrup", role: "sweetener" }],
  ["sugar", { ingredient: "sugar", role: "addon" }],

  ["orange", { ingredient: "orange", role: "addon" }],
]);

const GARNISH_RULES = [
  { match: /^lemon peel$/i, ingredient: "lemon peel" },
  { match: /^orange peel$/i, ingredient: "orange peel" },
  { match: /^orange spiral$/i, ingredient: "orange peel" },
  { match: /^garnish with orange peel$/i, ingredient: "orange peel" },
  { match: /^garnish with rosemary$/i, ingredient: "rosemary" },
  { match: /^1 wedge lemon$/i, ingredient: "lemon wedge" },
];

const SPECIAL_PHRASE_RULES = [
  {
    match: /^splash of soda water$/i,
    apply: (item) => ({
      ...item,
      amount: 0.5,
      unit: "oz",
      ingredient: "soda water",
      role: "topper",
      confidence: "medium",
      qualifiers: uniq([...(item.qualifiers || []), "splash"]),
    }),
  },
  {
    match: /^, orange carbonated soft drink$/i,
    apply: (item) => ({
      ...item,
      amount: null,
      unit: null,
      ingredient: "orange soda",
      role: "topper",
      confidence: "low",
    }),
  },
];

const JUICE_CONVERSIONS = [
  { match: /^1\/4 lemon$/i, amount: 0.5, ingredient: "lemon juice" },
  { match: /^1\/2 lemon$/i, amount: 1, ingredient: "lemon juice" },
  { match: /^1 lemon$/i, amount: 2, ingredient: "lemon juice" },
  { match: /^2cl lemon juice$/i, amount: 0.5, ingredient: "lemon juice" },

  { match: /^1\/4 lime$/i, amount: 0.5, ingredient: "lime juice" },
  { match: /^1\/2 lime$/i, amount: 1, ingredient: "lime juice" },
  { match: /^1 lime$/i, amount: 2, ingredient: "lime juice" },
  { match: /^1 lime juice$/i, amount: 2, ingredient: "lime juice" },
];

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function lc(s) {
  return normalizeWhitespace(s).toLowerCase();
}

function shouldExcludeCocktail(cocktail) {
  const allItems = [...(cocktail.ingredients || []), ...(cocktail.garnish || [])];
  return allItems.some((item) =>
    EXCLUDE_INGREDIENT_PATTERNS.some((re) => re.test(item.raw || "") || re.test(item.ingredient || ""))
  );
}

function isServingNote(item) {
  const ingredient = item.ingredient || "";
  const raw = item.raw || "";
  return REMOVE_AS_SERVING_NOTE_PATTERNS.some((re) => re.test(ingredient) || re.test(raw));
}

function applyJuiceConversion(item) {
  const raw = lc(item.raw || item.ingredient);
  for (const rule of JUICE_CONVERSIONS) {
    if (rule.match.test(raw)) {
      return {
        ...item,
        amount: rule.amount,
        unit: "oz",
        ingredient: rule.ingredient,
        role: "acid",
        confidence: "medium",
        qualifiers: uniq(item.qualifiers || []),
      };
    }
  }
  return item;
}

function applySpecialPhraseRules(item) {
  const key = lc(item.raw || item.ingredient);
  for (const rule of SPECIAL_PHRASE_RULES) {
    if (rule.match.test(key)) return rule.apply(item);
  }
  return item;
}

function applyIngredientAlias(item) {
  const key = lc(item.ingredient);
  const alias = INGREDIENT_ALIASES.get(key);
  if (!alias) return item;

  return {
    ...item,
    ingredient: alias.ingredient ?? item.ingredient,
    role: alias.role ?? item.role,
    qualifiers: uniq([...(item.qualifiers || []), ...(alias.qualifiers || [])]),
  };
}

function applyGarnishRule(item) {
  const key = lc(item.raw || item.ingredient);
  for (const rule of GARNISH_RULES) {
    if (rule.match.test(key)) {
      return {
        ...item,
        ingredient: rule.ingredient,
        role: "garnish",
        amount: null,
        unit: null,
        confidence: "medium",
      };
    }
  }
  return item;
}

function applyTopperHeuristics(item) {
  const ingredient = lc(item.ingredient);
  if (
    ingredient.includes("soda") ||
    ingredient.includes("ginger beer") ||
    ingredient.includes("ginger ale") ||
    ingredient.includes("cola") ||
    ingredient.includes("lemonade") ||
    ingredient.includes("coffee") ||
    ingredient.includes("beer") ||
    ingredient.includes("water")
  ) {
    return { ...item, role: "topper" };
  }
  return item;
}

function applyAddonHeuristics(item) {
  const ingredient = lc(item.ingredient);
  if (
    ingredient.includes("extract") ||
    ingredient.includes("salt") ||
    ingredient.includes("cloves") ||
    ingredient.includes("cinnamon") ||
    ingredient.includes("nutmeg") ||
    ingredient === "egg" ||
    ingredient.includes("whipped cream") ||
    ingredient.includes("sherbet")
  ) {
    return { ...item, role: "addon" };
  }
  return item;
}

function applyOrangeRule(item) {
  if (lc(item.ingredient) !== "orange") return item;

  const raw = lc(item.raw || "");
  if (raw.includes("juice")) {
    return {
      ...item,
      ingredient: "orange juice",
      role: "topper",
    };
  }

  if (raw.includes("garnish") || raw.includes("slice") || raw.includes("peel")) {
    return {
      ...item,
      ingredient: "orange peel",
      role: "garnish",
      amount: null,
      unit: null,
    };
  }

  return {
    ...item,
    role: "addon",
  };
}

function cleanItem(item) {
  let out = clone(item);

  out.raw = normalizeWhitespace(out.raw);
  out.ingredient = normalizeWhitespace(out.ingredient);
  out.qualifiers = uniq(out.qualifiers || []);

  out = applyJuiceConversion(out);
  out = applySpecialPhraseRules(out);
  out = applyGarnishRule(out);
  out = applyIngredientAlias(out);
  out = applyTopperHeuristics(out);
  out = applyAddonHeuristics(out);
  out = applyOrangeRule(out);

  if (lc(out.ingredient) === "carbonated water") {
    out.ingredient = "soda water";
    out.role = "topper";
  }

  if (lc(out.ingredient) === "ginger beer") {
    out.role = "topper";
  }

  return out;
}

function moveIngredientToGarnish(item) {
  return {
    raw: item.raw,
    amount: null,
    unit: null,
    ingredient: item.ingredient,
    role: "garnish",
    confidence: item.confidence || "medium",
    qualifiers: uniq(item.qualifiers || []),
  };
}

function cleanCocktail(cocktail) {
  const c = clone(cocktail);
  const newIngredients = [];
  const newGarnish = [...(c.garnish || [])];

  for (const item of c.ingredients || []) {
    if (isServingNote(item)) continue;

    const cleaned = cleanItem(item);

    if (cleaned.role === "garnish") {
      newGarnish.push(moveIngredientToGarnish(cleaned));
    } else {
      newIngredients.push(cleaned);
    }
  }

  c.ingredients = newIngredients;
  c.garnish = dedupeItems(newGarnish);
  return c;
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const key = [
      lc(item.ingredient),
      item.amount ?? "",
      lc(item.unit ?? ""),
      lc(item.role ?? ""),
      lc(item.raw ?? ""),
    ].join("::");

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

async function main() {
  const raw = JSON.parse(await fs.readFile(INPUT, "utf8"));

  const kept = [];
  const excluded = [];

  for (const cocktail of raw) {
    if (shouldExcludeCocktail(cocktail)) {
      excluded.push({
        name: cocktail.name,
        id: cocktail.id,
      });
      continue;
    }
    kept.push(cleanCocktail(cocktail));
  }

  await fs.writeFile(OUTPUT, JSON.stringify(kept, null, 2), "utf8");
  await fs.writeFile(
    "cocktails_cleaned_v2_excluded.json",
    JSON.stringify(excluded, null, 2),
    "utf8"
  );

  console.log(`Input cocktails: ${raw.length}`);
  console.log(`Kept cocktails: ${kept.length}`);
  console.log(`Excluded cocktails: ${excluded.length}`);
  console.log(`Wrote ${OUTPUT}`);
  console.log(`Wrote cocktails_cleaned_v2_excluded.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
