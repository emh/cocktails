// audit-cocktails.mjs
import fs from "node:fs/promises";

const INPUT = process.argv[2] || "cocktails_normalized.json";

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function topEntries(map, limit = 50) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function looksBrandLike(s) {
  return (
    /\b(smirnoff|bacardi|baileys|kahlua|luxardo|jack daniel'?s|jim beam|wild turkey|crown royal|campari|aperol|martini|gordon'?s|hennessy)\b/i.test(s) ||
    /\b(dr\.?\s*pepper|7-up|coca-cola)\b/i.test(s)
  );
}

function startsWeird(s) {
  return /^(a|an|of|with|and)\b/i.test(s);
}

function hasRangeOrHyphenNumber(raw) {
  return /\b\d+\s*-\s*\d+\b/.test(raw);
}

function suspiciousLeadingNumberIngredient(ing) {
  // catches bad parses like "-up", "cups yoghurt", "-6 ice"
  return /^[-\d]/.test(ing) || /^cups?\b/.test(ing);
}

function weirdUnit(unit) {
  if (!unit) return false;
  const ok = new Set([
    "oz", "ml", "cl", "l",
    "tsp", "tbsp",
    "dash", "drop", "part", "shot",
    "barspoon", "splash",
    "cup", "cups",
    "jigger", "jiggers",
    "pinch", "slice", "sprig", "wedge",
    "cube", "handful", "pcs", "piece", "pieces",
    "can", "bottle"
  ]);
  return !ok.has(unit);
}

function shouldLikelyBeEffervescence(ingredient) {
  return /\b(soda water|club soda|carbonated water|tonic|ginger beer|ginger ale|prosecco|champagne|cava|sparkling wine|cola|coca-cola|7-up|sprite|lemonade|root beer)\b/i.test(ingredient);
}

function shouldLikelyBeLiqueur(ingredient) {
  return /\b(liqueur|triple sec|curaçao|curacao|chartreuse|maraschino|falernum|benedictine|amaretto|campari|aperol|kahlua|sambuca|grand marnier|cr[eè]me de|creme de|cassis|chambord|schnapps)\b/i.test(ingredient);
}

function shouldLikelyBeBaseSpirit(ingredient) {
  return /\b(rum|gin|vodka|tequila|mezcal|whisk(?:e)?y|bourbon|rye|scotch|brandy|cognac|armagnac|applejack|pisco|cachaça|cachaca)\b/i.test(ingredient);
}

function shouldLikelyBeAcid(ingredient) {
  return /\b(lemon juice|lime juice|grapefruit juice|yuzu juice|citron juice)\b/i.test(ingredient);
}

function shouldLikelyBeSweetener(ingredient) {
  return /\b(syrup|grenadine|orgeat|honey|agave|sugar|demerara|simple syrup|maple syrup)\b/i.test(ingredient);
}

function shouldLikelyBeGarnish(ingredient, raw) {
  return /\b(cherry|twist|peel|zest|sprig|nutmeg|olive|slice|wedge|rim)\b/i.test(ingredient) ||
         /\b(garnish|rim)\b/i.test(raw);
}

function detectExpectedRole(ingredient, raw) {
  if (shouldLikelyBeGarnish(ingredient, raw)) return "garnish";
  if (shouldLikelyBeEffervescence(ingredient)) return "effervescence";
  if (shouldLikelyBeLiqueur(ingredient)) return "liqueur_modifier";
  if (shouldLikelyBeBaseSpirit(ingredient)) return "base_spirit";
  if (shouldLikelyBeAcid(ingredient)) return "acid";
  if (shouldLikelyBeSweetener(ingredient)) return "sweetener";
  return null;
}

function pushExample(map, key, example, maxPerKey = 5) {
  if (!map.has(key)) map.set(key, []);
  const arr = map.get(key);
  if (arr.length < maxPerKey) arr.push(example);
}

function formatExamples(list) {
  return list.map((x) =>
    `  - ${x.cocktail}: raw="${x.raw}" ingredient="${x.ingredient}" role="${x.role}" unit="${x.unit ?? ""}" confidence="${x.confidence ?? ""}"`
  ).join("\n");
}

async function main() {
  const text = await fs.readFile(INPUT, "utf8");
  const cocktails = JSON.parse(text);

  const roleCounts = new Map();
  const ingredientCounts = new Map();
  const unitCounts = new Map();
  const confidenceCounts = new Map();

  const otherIngredients = new Map();
  const lowConfidenceIngredients = new Map();
  const weirdStartingIngredients = new Map();
  const brandIngredients = new Map();
  const weirdUnits = new Map();
  const roleMismatchCounts = new Map();
  const roleMismatchExamples = new Map();
  const phraseyIngredients = new Map();
  const suspiciousParseExamples = [];
  const garnishCandidates = [];
  const rangeExamples = [];

  for (const cocktail of cocktails) {
    for (const item of [...(cocktail.ingredients || []), ...(cocktail.garnish || [])]) {
      const ingredient = normalizeWhitespace(item.ingredient);
      const raw = normalizeWhitespace(item.raw);
      const role = normalizeWhitespace(item.role || "unknown");
      const unit = normalizeWhitespace(item.unit || "");
      const confidence = normalizeWhitespace(item.confidence || "unknown");

      inc(roleCounts, role);
      inc(confidenceCounts, confidence);
      if (ingredient) inc(ingredientCounts, ingredient);
      if (unit) inc(unitCounts, unit);

      const example = {
        cocktail: cocktail.name,
        raw,
        ingredient,
        role,
        unit: unit || null,
        confidence
      };

      if (role === "other") {
        inc(otherIngredients, ingredient || "(blank)");
      }

      if (confidence === "low") {
        inc(lowConfidenceIngredients, ingredient || "(blank)");
      }

      if (ingredient && startsWeird(ingredient)) {
        inc(weirdStartingIngredients, ingredient);
      }

      if (ingredient && looksBrandLike(ingredient)) {
        inc(brandIngredients, ingredient);
      }

      if (unit && weirdUnit(unit)) {
        inc(weirdUnits, unit);
      }

      if (
        /\b(sweet and sour|mix|with | of | top up | fill | splash|around rim|to top)\b/i.test(raw) ||
        /\b(with | of )\b/i.test(ingredient)
      ) {
        inc(phraseyIngredients, ingredient || raw);
      }

      if (hasRangeOrHyphenNumber(raw)) {
        rangeExamples.push(example);
      }

      if (suspiciousLeadingNumberIngredient(ingredient)) {
        suspiciousParseExamples.push(example);
      }

      const expectedRole = detectExpectedRole(ingredient, raw);
      if (expectedRole && expectedRole !== role) {
        const key = `${role} -> ${expectedRole}`;
        inc(roleMismatchCounts, key);
        pushExample(roleMismatchExamples, key, example);
      }

      if (shouldLikelyBeGarnish(ingredient, raw) && role !== "garnish") {
        garnishCandidates.push(example);
      }
    }
  }

  const report = {
    file: INPUT,
    totals: {
      cocktails: cocktails.length,
      role_counts: Object.fromEntries([...roleCounts.entries()].sort()),
      confidence_counts: Object.fromEntries([...confidenceCounts.entries()].sort())
    },
    top_other_ingredients: topEntries(otherIngredients, 100),
    top_low_confidence_ingredients: topEntries(lowConfidenceIngredients, 100),
    top_ingredients: topEntries(ingredientCounts, 100),
    units: topEntries(unitCounts, 100),
    weird_starting_ingredients: topEntries(weirdStartingIngredients, 100),
    brand_like_ingredients: topEntries(brandIngredients, 100),
    weird_units: topEntries(weirdUnits, 100),
    role_mismatches: topEntries(roleMismatchCounts, 100).map(({ key, count }) => ({
      key,
      count,
      examples: roleMismatchExamples.get(key) || []
    })),
    phrasey_ingredients: topEntries(phraseyIngredients, 100),
    suspicious_parse_examples: suspiciousParseExamples.slice(0, 200),
    garnish_candidates: garnishCandidates.slice(0, 200),
    range_examples: rangeExamples.slice(0, 100)
  };

  const outJson = "cocktails_audit.json";
  await fs.writeFile(outJson, JSON.stringify(report, null, 2), "utf8");

  console.log(`Audit written to ${outJson}\n`);

  console.log("=== Totals ===");
  console.log(`Cocktails: ${report.totals.cocktails}`);
  console.log("Roles:", report.totals.role_counts);
  console.log("Confidence:", report.totals.confidence_counts);

  console.log("\n=== Top role=other ingredients ===");
  for (const row of report.top_other_ingredients.slice(0, 30)) {
    console.log(`${row.count.toString().padStart(4)}  ${row.key}`);
  }

  console.log("\n=== Top confidence=low ingredients ===");
  for (const row of report.top_low_confidence_ingredients.slice(0, 30)) {
    console.log(`${row.count.toString().padStart(4)}  ${row.key}`);
  }

  console.log("\n=== Brand-like ingredients ===");
  for (const row of report.brand_like_ingredients.slice(0, 30)) {
    console.log(`${row.count.toString().padStart(4)}  ${row.key}`);
  }

  console.log("\n=== Weird starting ingredients ===");
  for (const row of report.weird_starting_ingredients.slice(0, 30)) {
    console.log(`${row.count.toString().padStart(4)}  ${row.key}`);
  }

  console.log("\n=== Weird units ===");
  for (const row of report.weird_units.slice(0, 30)) {
    console.log(`${row.count.toString().padStart(4)}  ${row.key}`);
  }

  console.log("\n=== Role mismatches ===");
  for (const row of report.role_mismatches.slice(0, 20)) {
    console.log(`\n${row.count.toString().padStart(4)}  ${row.key}`);
    console.log(formatExamples(row.examples));
  }

  console.log("\n=== Suspicious parse examples ===");
  for (const ex of report.suspicious_parse_examples.slice(0, 25)) {
    console.log(`- ${ex.cocktail}: raw="${ex.raw}" -> ingredient="${ex.ingredient}" unit="${ex.unit ?? ""}"`);
  }

  console.log("\n=== Phrasey leftovers ===");
  for (const row of report.phrasey_ingredients.slice(0, 30)) {
    console.log(`${row.count.toString().padStart(4)}  ${row.key}`);
  }

  console.log("\n=== Garnish candidates not marked garnish ===");
  for (const ex of report.garnish_candidates.slice(0, 25)) {
    console.log(`- ${ex.cocktail}: raw="${ex.raw}" ingredient="${ex.ingredient}" role="${ex.role}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
