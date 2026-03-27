// cocktail-scraper.mjs
import fs from "node:fs/promises";
import * as cheerio from "cheerio";

const USER_AGENT = "Mozilla/5.0 cocktail-dataset-builder/0.1";
const SLEEP_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return res.json();
}

function parseFractionOrFloat(value) {
  const v = value.trim();

  if (/^\d+\/\d+$/.test(v)) {
    const [num, den] = v.split("/");
    return Number(num) / Number(den);
  }

  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseRawIngredient(text) {
  const raw = text.replace(/\s+/g, " ").trim();

  // Examples:
  // "2 oz White Rum"
  // "1/2 oz Lime Juice"
  // "50 ml Tequila 100% Agave"
  const match = raw.match(/^\s*(\d+(?:\.\d+)?|\d+\/\d+)\s*([a-zA-Z]+)?\s+(.+)$/);

  if (!match) {
    return {
      raw,
      amount: null,
      unit: null,
      ingredient: raw.toLowerCase()
    };
  }

  const [, amountRaw, unit, ingredient] = match;

  return {
    raw,
    amount: parseFractionOrFloat(amountRaw),
    unit: unit ? unit.toLowerCase() : null,
    ingredient: ingredient.trim().toLowerCase()
  };
}

function normalizeCocktailDbDrink(drink) {
  const ingredients = [];

  for (let i = 1; i <= 15; i += 1) {
    const ing = drink[`strIngredient${i}`];
    const meas = drink[`strMeasure${i}`];

    if (!ing || !String(ing).trim()) continue;

    const raw = `${(meas || "").trim()} ${String(ing).trim()}`.trim();
    const entry = parseRawIngredient(raw);

    if (!entry.ingredient) {
      entry.ingredient = String(ing).trim().toLowerCase();
    }

    ingredients.push(entry);
  }

  const tags = [];

  for (const field of ["strCategory", "strAlcoholic", "strIBA", "strTags"]) {
    const value = drink[field];
    if (!value) continue;

    if (field === "strTags") {
      tags.push(
        ...String(value)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    } else {
      tags.push(String(value).trim());
    }
  }

  return {
    id: `thecocktaildb:${drink.idDrink}`,
    source: "thecocktaildb",
    name: (drink.strDrink || "").trim(),
    category: drink.strCategory || null,
    ingredients,
    method: drink.strInstructions || null,
    garnish: null,
    glass: drink.strGlass || null,
    image_url: drink.strDrinkThumb || null,
    tags,
    source_url: `https://www.thecocktaildb.com/drink/${drink.idDrink}`
  };
}

async function fetchCocktailDbByLetter(letter) {
  const url = `https://www.thecocktaildb.com/api/json/v1/1/search.php?f=${encodeURIComponent(letter)}`;
  const data = await fetchJson(url);
  return data.drinks || [];
}

async function scrapeCocktailDb() {
  const results = [];
  const seenIds = new Set();

  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    try {
      const drinks = await fetchCocktailDbByLetter(letter);

      for (const drink of drinks) {
        if (seenIds.has(drink.idDrink)) continue;
        seenIds.add(drink.idDrink);
        results.push(normalizeCocktailDbDrink(drink));
      }

      console.log(`[cocktaildb] ${letter}: +${drinks.length}`);
    } catch (err) {
      console.error(`[cocktaildb] failed for ${letter}:`, err.message);
    }

    await sleep(SLEEP_MS);
  }

  return results;
}

function extractTextUntilNextHeading($, headingEl) {
  const chunks = [];
  let node = headingEl.next();

  while (node.length) {
    const tag = (node[0]?.tagName || "").toLowerCase();
    if (["h2", "h3", "h4"].includes(tag)) break;

    const text = node.text().replace(/\s+/g, " ").trim();
    if (text) chunks.push(text);

    node = node.next();
  }

  return chunks.length ? chunks.join("\n") : null;
}

function findHeadingByText($, headingText) {
  const headings = $("h2, h3, h4").toArray();

  for (const el of headings) {
    const text = $(el).text().replace(/\s+/g, " ").trim().toLowerCase();
    if (text.includes(headingText.toLowerCase())) {
      return $(el);
    }
  }

  return null;
}

function parseIbaIngredients($) {
  const heading = findHeadingByText($, "ingredients");
  if (!heading) return [];

  const items = [];
  let node = heading.next();

  while (node.length) {
    const tag = (node[0]?.tagName || "").toLowerCase();
    if (["h2", "h3", "h4"].includes(tag)) break;

    if (tag === "ul") {
      node.find("li").each((_, li) => {
        const text = $(li).text().replace(/\s+/g, " ").trim();
        if (text) items.push(parseRawIngredient(text));
      });
    } else {
      const lines = node
        .text()
        .split("\n")
        .map((s) => s.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      for (const line of lines) {
        items.push(parseRawIngredient(line));
      }
    }

    node = node.next();
  }

  return items;
}

async function extractIbaCocktailLinks() {
  const listingPages = [
    "https://iba-world.com/cocktails/all-cocktails/",
    "https://iba-world.com/cocktails/all-cocktails/page/2/",
    "https://iba-world.com/cocktails/all-cocktails/page/3/",
    "https://iba-world.com/cocktails/all-cocktails/page/4/",
    "https://iba-world.com/cocktails/all-cocktails/page/5/"
  ];

  const links = new Set();

  for (const url of listingPages) {
    try {
      const html = await fetchText(url);
      const $ = cheerio.load(html);

      $("a[href]").each((_, a) => {
        const href = $(a).attr("href");
        if (href && href.includes("/iba-cocktail/")) {
          links.add(href);
        }
      });

      console.log(`[iba] scanned listing page: ${url}`);
    } catch (err) {
      console.error(`[iba] failed listing page ${url}:`, err.message);
    }

    await sleep(SLEEP_MS);
  }

  return [...links].sort();
}

async function scrapeIbaCocktail(url) {
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const name =
    $("h1").first().text().replace(/\s+/g, " ").trim() ||
    url.replace(/\/$/, "").split("/").at(-1).replace(/-/g, " ");

  const pageText = $("body")
    .text()
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  let category = null;
  for (const label of ["The unforgettables", "Contemporary Classics", "New Era"]) {
    if (pageText.some(line => line.toLowerCase() === label.toLowerCase())) {
      category = label;
      break;
    }
  }

  function extractSectionLines(startLabel, endLabels) {
    const startIdx = pageText.findIndex(
      line => line.toLowerCase() === startLabel.toLowerCase()
    );
    if (startIdx === -1) return [];

    let endIdx = pageText.length;
    for (let i = startIdx + 1; i < pageText.length; i++) {
      const line = pageText[i].toLowerCase();
      if (endLabels.some(label => line === label.toLowerCase())) {
        endIdx = i;
        break;
      }
    }

    return pageText.slice(startIdx + 1, endIdx).filter(Boolean);
  }

  const ingredientLines = extractSectionLines("Ingredients", ["Method"]);
  const methodLines = extractSectionLines("Method", ["Garnish", "MOST VIEWED COCKTAILS"]);
  const garnishLines = extractSectionLines("Garnish", ["MOST VIEWED COCKTAILS"]);

  const ingredients = ingredientLines
    .filter(line => {
      const lower = line.toLowerCase();
      if (lower.includes("views")) return false;
      if (lower === "play video") return false;
      if (lower === "image") return false;
      return true;
    })
    .map(parseRawIngredient);

  const method = methodLines.length ? methodLines.join("\n") : null;
  const garnish = garnishLines.length ? garnishLines.join("\n") : null;

  return {
    id: `iba:${url.replace(/\/$/, "").split("/").at(-1)}`,
    source: "iba",
    name,
    category,
    ingredients,
    method,
    garnish,
    glass: null,
    image_url: null,
    tags: [],
    source_url: url
  };
}

async function scrapeIba() {
  const urls = await extractIbaCocktailLinks();
  const results = [];

  for (const url of urls) {
    try {
      const cocktail = await scrapeIbaCocktail(url);
      results.push(cocktail);
      console.log(`[iba] scraped: ${cocktail.name}`);
    } catch (err) {
      console.error(`[iba] failed detail ${url}:`, err.message);
    }

    await sleep(SLEEP_MS);
  }

  return results;
}

function dedupeBySourceAndName(cocktails) {
  const seen = new Set();
  const out = [];

  for (const c of cocktails) {
    const key = `${c.source}::${c.name.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }

  return out;
}

async function main() {
  const [cocktailDb, iba] = await Promise.all([
    scrapeCocktailDb(),
    scrapeIba()
  ]);

  const all = dedupeBySourceAndName([...cocktailDb, ...iba]);

  await fs.writeFile(
    "cocktails_raw.json",
    JSON.stringify(all, null, 2),
    "utf8"
  );

  console.log(`\nWrote cocktails_raw.json`);
  console.log(`TheCocktailDB: ${cocktailDb.length}`);
  console.log(`IBA: ${iba.length}`);
  console.log(`Total: ${all.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
