// build-cocktail-graph.mjs
import fs from "node:fs/promises";

const INPUT = process.argv[2] || "cocktails_normalized.json";
const GRAPH_OUT = process.argv[3] || "cocktail_graph.json";
const MOVES_OUT = process.argv[4] || "cocktail_moves.json";

const MAX_MOVES_PER_TYPE = {
  local_small: 4,
  local_large: 4,
  global: 4,
};

const IGNORED_ROLES = new Set(["garnish"]);
const OPTIONAL_ROLES = new Set(["egg", "dairy", "bittering_agent"]);
const CORE_ROLES = new Set([
  "base_spirit",
  "liqueur_modifier",
  "fortified_wine",
  "acid",
  "sweetener",
  "effervescence",
  "juice",
  "egg",
  "dairy",
  "bittering_agent",
]);

const SMALL_MOVE_ROLES = new Set([
  "acid",
  "sweetener",
  "bittering_agent",
  "liqueur_modifier",
  "fortified_wine",
  "juice",
]);

const LARGE_MOVE_ROLES = new Set(["base_spirit"]);

function normalizeWhitespace(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function slugify(s) {
  return normalizeWhitespace(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function uniq(arr) {
  return [...new Set(arr)];
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function amountToOz(amount, unit) {
  if (amount == null) return null;
  const u = normalizeWhitespace(unit).toLowerCase();

  if (!u) return amount; // parts/shots/etc often relative; keep raw amount
  if (u === "oz") return amount;
  if (u === "ml") return amount / 29.5735;
  if (u === "cl") return (amount * 10) / 29.5735;
  if (u === "l") return (amount * 1000) / 29.5735;
  if (u === "tsp") return amount * (1 / 6);
  if (u === "tbsp") return amount * 0.5;
  if (u === "barspoon") return amount * (1 / 6);
  if (u === "dash") return amount * 0.03125;
  if (u === "drop") return amount * 0.0017;
  if (u === "shot") return amount * 1.5;

  // for part / unknown, preserve relative amount
  return amount;
}

function canonicalIngredientName(name) {
  const s = normalizeWhitespace(name).toLowerCase();

  const aliases = new Map([
    ["light rum", "white rum"],
    ["white cuban ron", "white rum"],
    ["sweet red vermouth", "sweet vermouth"],
    ["red sweet vermouth", "sweet vermouth"],
    ["bitter campari", "campari"],
    ["grand marnier", "orange liqueur"],
    ["cointreau", "orange liqueur"],
    ["triple sec", "orange liqueur"],
    ["blue curacao", "orange liqueur"],
    ["blue curaçao", "orange liqueur"],
    ["curacao", "orange liqueur"],
    ["curaçao", "orange liqueur"],
    ["maraschino luxardo", "maraschino liqueur"],
    ["irish cream liqueur", "irish cream liqueur"],
    ["tonic water", "tonic"],
    ["club soda", "soda water"],
    ["carbonated water", "soda water"],
    ["a splash of soda water", "soda water"],
    ["with soda water", "soda water"],
  ]);

  return aliases.get(s) || s;
}

function simplifyRole(role, ingredient) {
  const r = normalizeWhitespace(role).toLowerCase();
  const ing = canonicalIngredientName(ingredient);

  if (r === "other") {
    if (
      ing.includes("liqueur") ||
      ing.includes("amaretto") ||
      ing.includes("campari") ||
      ing.includes("aperol") ||
      ing.includes("chartreuse") ||
      ing.includes("sambuca") ||
      ing.includes("crème de") ||
      ing.includes("creme de") ||
      ing.includes("kahlua") ||
      ing.includes("schnapps")
    ) {
      return "liqueur_modifier";
    }
    if (
      ing.includes("soda") ||
      ing.includes("tonic") ||
      ing.includes("cola") ||
      ing.includes("prosecco") ||
      ing.includes("champagne") ||
      ing.includes("ginger beer") ||
      ing.includes("ginger ale")
    ) {
      return "effervescence";
    }
  }

  if (r === "dairy") return "dairy";
  if (r === "juice") return "juice";
  return r;
}

function extractFeatures(cocktail) {
  const items = (cocktail.ingredients || [])
    .filter((x) => !IGNORED_ROLES.has(x.role))
    .map((x) => {
      const ingredient = canonicalIngredientName(x.ingredient);
      const role = simplifyRole(x.role, ingredient);
      return {
        ingredient,
        role,
        amount: x.amount,
        unit: x.unit,
        amountOz: amountToOz(x.amount, x.unit),
        confidence: x.confidence || "unknown",
      };
    })
    .filter((x) => CORE_ROLES.has(x.role));

  const byRole = new Map();
  for (const item of items) {
    if (!byRole.has(item.role)) byRole.set(item.role, []);
    byRole.get(item.role).push(item);
  }

  // stable sort within role
  for (const arr of byRole.values()) {
    arr.sort((a, b) => a.ingredient.localeCompare(b.ingredient));
  }

  const roles = [...byRole.keys()].sort();
  const base = (byRole.get("base_spirit") || []).map((x) => x.ingredient);
  const acids = (byRole.get("acid") || []).map((x) => x.ingredient);
  const sweeteners = (byRole.get("sweetener") || []).map((x) => x.ingredient);
  const effervescence = (byRole.get("effervescence") || []).map((x) => x.ingredient);
  const liqueurs = (byRole.get("liqueur_modifier") || []).map((x) => x.ingredient);
  const fortified = (byRole.get("fortified_wine") || []).map((x) => x.ingredient);
  const juices = (byRole.get("juice") || []).map((x) => x.ingredient);

  const structuralSignature = roles
    .map((role) => `${role}:${(byRole.get(role) || []).length}`)
    .join("|");

  const coreSignature = [
    `base:${base.length}`,
    `acid:${acids.length}`,
    `sweet:${sweeteners.length}`,
    `liq:${liqueurs.length}`,
    `fort:${fortified.length}`,
    `eff:${effervescence.length}`,
    `juice:${juices.length}`,
  ].join("|");

  return {
    items,
    byRole,
    roles,
    base,
    acids,
    sweeteners,
    effervescence,
    liqueurs,
    fortified,
    juices,
    structuralSignature,
    coreSignature,
    template: inferTemplate(byRole),
    ratioShape: inferRatioShape(byRole),
  };
}

function inferTemplate(byRole) {
  const has = (role) => (byRole.get(role) || []).length > 0;
  const count = (role) => (byRole.get(role) || []).length;

  if (count("base_spirit") >= 1 && has("acid") && has("sweetener") && !has("effervescence")) {
    if (has("egg")) return "sour_with_egg";
    if (has("liqueur_modifier")) return "daisy_or_sidecar";
    return "sour";
  }

  if (count("base_spirit") >= 1 && has("effervescence")) {
    if (has("acid")) return "highball_sour";
    return "highball";
  }

  if (
    count("base_spirit") >= 1 &&
    (has("fortified_wine") || has("liqueur_modifier")) &&
    !has("acid") &&
    !has("juice") &&
    !has("effervescence")
  ) {
    if (has("fortified_wine") && has("liqueur_modifier")) return "aromatic_spirit_forward";
    if (has("fortified_wine")) return "martini_manhattan";
    return "spirit_forward_modified";
  }

  if (!has("base_spirit") && has("effervescence")) return "spritz_like";
  if (!has("base_spirit") && has("juice")) return "juice_mix";
  if (has("dairy")) return "cream_drink";

  return "other";
}

function inferRatioShape(byRole) {
  const main = [];

  for (const role of [
    "base_spirit",
    "fortified_wine",
    "liqueur_modifier",
    "acid",
    "sweetener",
    "effervescence",
    "juice",
  ]) {
    const arr = byRole.get(role) || [];
    const total = sum(arr.map((x) => x.amountOz).filter((x) => x != null));
    if (total > 0) main.push({ role, total });
  }

  if (main.length < 2) return "unknown";

  const vals = main.map((x) => x.total).sort((a, b) => a - b);
  const min = vals[0];
  const max = vals[vals.length - 1];

  if (min > 0 && max / min <= 1.25) return "equal_parts";
  if (vals.length === 3 && vals[2] / vals[1] <= 1.4 && vals[1] / vals[0] >= 1.7) return "2_1_0.5ish";
  if (vals.length === 3 && vals[2] / vals[1] >= 1.7 && vals[1] / vals[0] <= 1.4) return "long_topper";
  return "uneven";
}

function roleIngredientMap(features) {
  const map = new Map();
  for (const [role, items] of features.byRole.entries()) {
    map.set(role, items.map((x) => x.ingredient).sort());
  }
  return map;
}

function diffRoleMaps(a, b) {
  const roles = uniq([...a.keys(), ...b.keys()]).sort();
  const changes = [];

  for (const role of roles) {
    const left = a.get(role) || [];
    const right = b.get(role) || [];
    const leftKey = left.join("|");
    const rightKey = right.join("|");
    if (leftKey === rightKey) continue;

    const removed = left.filter((x) => !right.includes(x));
    const added = right.filter((x) => !left.includes(x));

    changes.push({ role, removed, added });
  }

  return changes;
}

function sharedCoreCount(a, b) {
  const A = new Set(a.items.map((x) => `${x.role}:${x.ingredient}`));
  const B = new Set(b.items.map((x) => `${x.role}:${x.ingredient}`));
  let n = 0;
  for (const x of A) if (B.has(x)) n += 1;
  return n;
}

function chooseDirection(changes) {
  const rolePriority = [
    "base_spirit",
    "acid",
    "sweetener",
    "effervescence",
    "liqueur_modifier",
    "fortified_wine",
    "juice",
    "egg",
    "dairy",
    "bittering_agent",
  ];

  const dominant = [...changes].sort(
    (a, b) => rolePriority.indexOf(a.role) - rolePriority.indexOf(b.role)
  )[0];

  if (!dominant) return "misc";
  switch (dominant.role) {
    case "base_spirit":
      return "up";
    case "acid":
    case "sweetener":
      return "right";
    case "effervescence":
      return "down";
    case "liqueur_modifier":
    case "fortified_wine":
    case "bittering_agent":
      return "left";
    case "juice":
      return "down_right";
    case "egg":
    case "dairy":
      return "down_left";
    default:
      return "misc";
  }
}

function classifyMove(aFeat, bFeat, changes) {
  const changedRoles = changes.map((x) => x.role);
  const roleSetEqual = aFeat.structuralSignature === bFeat.structuralSignature;
  const templateEqual = aFeat.template === bFeat.template;

  if (changes.length === 0) return null;

  if (roleSetEqual && templateEqual) {
    if (
      changes.length === 1 &&
      changes[0].role === "base_spirit" &&
      changes[0].removed.length === 1 &&
      changes[0].added.length === 1
    ) {
      return "local_large";
    }

    if (
      changes.length <= 2 &&
      changedRoles.every((r) => SMALL_MOVE_ROLES.has(r) || OPTIONAL_ROLES.has(r))
    ) {
      return "local_small";
    }
  }

  // Template move: keep it conservative
  if (aFeat.template !== bFeat.template) {
    const shared = sharedCoreCount(aFeat, bFeat);
    if (shared >= 2) return "global";
    if (
      (aFeat.template === "sour" && bFeat.template === "highball_sour") ||
      (aFeat.template === "highball_sour" && bFeat.template === "sour") ||
      (aFeat.template === "martini_manhattan" && bFeat.template === "aromatic_spirit_forward") ||
      (aFeat.template === "aromatic_spirit_forward" && bFeat.template === "martini_manhattan")
    ) {
      return "global";
    }
  }

  return null;
}

function describeMove(type, changes) {
  const bits = [];

  for (const c of changes) {
    if (c.removed.length && c.added.length) {
      bits.push(`${c.removed.join(", ")} → ${c.added.join(", ")}`);
    } else if (c.added.length) {
      bits.push(`add ${c.added.join(", ")}`);
    } else if (c.removed.length) {
      bits.push(`remove ${c.removed.join(", ")}`);
    }
  }

  const summary = bits.join("; ");

  if (type === "local_small") return summary || "small local move";
  if (type === "local_large") return summary || "base spirit swap";
  return summary || "template shift";
}

function edgeScore(type, aFeat, bFeat, changes) {
  const shared = sharedCoreCount(aFeat, bFeat);
  let score = 0;

  if (type === "local_small") score += 100;
  if (type === "local_large") score += 90;
  if (type === "global") score += 70;

  score += shared * 10;
  score -= changes.length * 8;

  if (aFeat.template === bFeat.template) score += 12;
  if (aFeat.ratioShape === bFeat.ratioShape) score += 8;

  return score;
}

function shouldKeepCocktail(cocktail, feat) {
  if (!cocktail.name || !cocktail.name_key) return false;
  if (feat.items.length < 2) return false;
  if (feat.template === "other") return false;
  if ((cocktail.tags || []).includes("non_alcoholic")) return false;
  return true;
}

function buildNodes(cocktails) {
  return cocktails
    .map((cocktail) => {
      const features = extractFeatures(cocktail);
      return {
        id: cocktail.id,
        name: cocktail.name,
        name_key: cocktail.name_key,
        category: cocktail.category || null,
        source: cocktail.source,
        tags: cocktail.tags || [],
        template: features.template,
        ratioShape: features.ratioShape,
        structuralSignature: features.structuralSignature,
        features,
      };
    })
    .filter((node) => shouldKeepCocktail(node, node.features));
}

function generateEdges(nodes) {
  const edges = [];
  const byTemplate = new Map();

  for (const node of nodes) {
    if (!byTemplate.has(node.template)) byTemplate.set(node.template, []);
    byTemplate.get(node.template).push(node);
  }

  // Candidate sets: same template + known adjacent template groups
  const templateAdjacency = new Map([
    ["sour", new Set(["sour", "sour_with_egg", "daisy_or_sidecar", "highball_sour"])],
    ["sour_with_egg", new Set(["sour", "sour_with_egg", "daisy_or_sidecar"])],
    ["daisy_or_sidecar", new Set(["sour", "daisy_or_sidecar", "highball_sour"])],
    ["highball_sour", new Set(["sour", "daisy_or_sidecar", "highball_sour", "highball"])],
    ["highball", new Set(["highball", "highball_sour", "spritz_like"])],
    ["martini_manhattan", new Set(["martini_manhattan", "aromatic_spirit_forward"])],
    ["aromatic_spirit_forward", new Set(["martini_manhattan", "aromatic_spirit_forward", "spritz_like"])],
    ["spritz_like", new Set(["spritz_like", "highball", "aromatic_spirit_forward"])],
  ]);

  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    const allowedTemplates = templateAdjacency.get(a.template) || new Set([a.template]);

    const candidates = nodes.filter(
      (n, idx) => idx !== i && allowedTemplates.has(n.template)
    );

    for (const b of candidates) {
      if (a.id >= b.id) continue; // undirected dedupe

      const aMap = roleIngredientMap(a.features);
      const bMap = roleIngredientMap(b.features);
      const changes = diffRoleMaps(aMap, bMap);

      const moveType = classifyMove(a.features, b.features, changes);
      if (!moveType) continue;

      const score = edgeScore(moveType, a.features, b.features, changes);
      if (score < 60) continue;

      edges.push({
        from: a.id,
        to: b.id,
        moveType,
        radius: moveType === "local_small" ? "inner" : moveType === "local_large" ? "middle" : "outer",
        direction: chooseDirection(changes),
        score,
        description: describeMove(moveType, changes),
        changedRoles: changes.map((x) => x.role),
        diff: changes,
        fromTemplate: a.template,
        toTemplate: b.template,
      });
    }
  }

  return edges;
}

function indexEdgesByNode(nodes, edges) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map(nodes.map((n) => [n.id, []]));

  for (const e of edges) {
    const a = nodeMap.get(e.from);
    const b = nodeMap.get(e.to);

    adjacency.get(e.from).push({
      targetId: e.to,
      targetName: b.name,
      ...e,
    });

    adjacency.get(e.to).push({
      targetId: e.from,
      targetName: a.name,
      from: e.to,
      to: e.from,
      moveType: e.moveType,
      radius: e.radius,
      direction: e.direction,
      score: e.score,
      description: e.description,
      changedRoles: e.changedRoles,
      diff: e.diff.map((d) => ({
        role: d.role,
        removed: d.added,
        added: d.removed,
      })),
      fromTemplate: e.toTemplate,
      toTemplate: e.fromTemplate,
    });
  }

  // prune for UI
  for (const [id, arr] of adjacency.entries()) {
    const grouped = {
      local_small: [],
      local_large: [],
      global: [],
    };

    for (const move of arr) grouped[move.moveType].push(move);

    const pruned = [];
    for (const type of ["local_small", "local_large", "global"]) {
      const deduped = dedupeMoves(grouped[type])
        .sort((a, b) => b.score - a.score || a.targetName.localeCompare(b.targetName))
        .slice(0, MAX_MOVES_PER_TYPE[type]);
      pruned.push(...deduped);
    }

    adjacency.set(
      id,
      pruned.sort((a, b) => {
        const order = { local_small: 0, local_large: 1, global: 2 };
        return order[a.moveType] - order[b.moveType] || b.score - a.score;
      })
    );
  }

  return adjacency;
}

function dedupeMoves(moves) {
  const seen = new Set();
  const out = [];

  for (const m of moves) {
    const key = [
      m.targetId,
      m.moveType,
      m.description,
      m.direction,
    ].join("::");

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }

  return out;
}

async function main() {
  const cocktails = JSON.parse(await fs.readFile(INPUT, "utf8"));
  const nodes = buildNodes(cocktails);
  const edges = generateEdges(nodes);
  const adjacency = indexEdgesByNode(nodes, edges);

  const graph = {
    meta: {
      input: INPUT,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      maxMovesPerType: MAX_MOVES_PER_TYPE,
    },
    nodes: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      name_key: n.name_key,
      source: n.source,
      category: n.category,
      tags: n.tags,
      template: n.template,
      ratioShape: n.ratioShape,
      ingredients: n.features.items.map((x) => ({
        ingredient: x.ingredient,
        role: x.role,
        amount: x.amount,
        unit: x.unit,
      })),
    })),
    edges,
  };

  const moveList = {
    meta: graph.meta,
    movesByCocktail: Object.fromEntries(
      [...adjacency.entries()].map(([id, moves]) => [
        id,
        {
          moves,
        },
      ])
    ),
  };

  await fs.writeFile(GRAPH_OUT, JSON.stringify(graph, null, 2), "utf8");
  await fs.writeFile(MOVES_OUT, JSON.stringify(moveList, null, 2), "utf8");

  console.log(`nodes: ${nodes.length}`);
  console.log(`edges: ${edges.length}`);
  console.log(`wrote ${GRAPH_OUT}`);
  console.log(`wrote ${MOVES_OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
