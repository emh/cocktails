const DATA_URLS = Object.freeze({
  graph: "./prototype/cocktail_graph.json",
  moves: "./prototype/cocktail_moves.json",
});

const DISPLAY_LIMIT = 9;
const SEARCH_LIMIT = 18;
const FAVORITES_STORAGE_KEY = "cocktail-constellation-favorites";
const historyStack = [];
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
const moveOrder = { local_small: 0, local_large: 1, global: 2 };

const state = {
  graphData: null,
  currentId: null,
  nodePositions: new Map(),
  nodeElements: new Map(),
  favoriteIds: [],
  favoritesOpen: false,
  searchOpen: false,
  isAnimating: false,
};

function norm(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function lc(value) {
  return norm(value).toLowerCase();
}

function choice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function lerp(min, max, amount) {
  return min + (max - min) * amount;
}

function pairKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function byId(id) {
  return state.graphData?.nodesById.get(id) ?? null;
}

function fmtAmount(amount, unit) {
  if (amount == null) return "";
  const rounded = Number.isInteger(amount) ? String(amount) : `${Math.round(amount * 100) / 100}`;
  return unit ? `${rounded} ${unit}` : rounded;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readFavoriteIds() {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function persistFavoriteIds() {
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(state.favoriteIds));
  } catch {
    // Ignore persistence failures and keep the in-memory list working.
  }
}

function syncFavoriteIds(ids) {
  const unique = [...new Set(ids)];
  state.favoriteIds = state.graphData
    ? unique.filter((id) => state.graphData.nodesById.has(id))
    : unique;
  persistFavoriteIds();
}

function sortIngredients(items) {
  return [...items].sort((left, right) => {
    const leftIndex = rolePriority.indexOf(left.role);
    const rightIndex = rolePriority.indexOf(right.role);
    const roleDelta = (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex);
    if (roleDelta !== 0) return roleDelta;
    return left.ingredient.localeCompare(right.ingredient);
  });
}

function setAppState(nextState, message = "") {
  const app = document.getElementById("app");
  const graph = document.getElementById("graph");
  const overlay = document.getElementById("loadingOverlay");
  const loadingMessage = document.getElementById("loadingMessage");
  app.dataset.state = nextState;
  graph.setAttribute("aria-busy", nextState === "loading" ? "true" : "false");
  overlay.hidden = nextState === "ready";
  overlay.setAttribute("aria-hidden", nextState === "ready" ? "true" : "false");
  if (message) {
    loadingMessage.textContent = message;
  }
}

function setStatus(message) {
  document.getElementById("status").textContent = message;
}

function setControlsEnabled(enabled) {
  document.getElementById("listToggleBtn").disabled = !enabled;
  document.getElementById("randomBtn").disabled = !enabled;
  document.getElementById("searchToggleBtn").disabled = !enabled;
  document.getElementById("searchInput").disabled = !enabled;
  updateBackButton();
  updateFavoritesUi();
}

function updateBackButton() {
  document.getElementById("backBtn").disabled = historyStack.length === 0 || !state.graphData;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return response.json();
}

function buildGraphData(graphJson, movesJson) {
  const nodes = (graphJson.nodes || []).map((node) => ({
    ...node,
    features: {
      items: sortIngredients(
        (node.ingredients || []).map((ingredient) => ({
          ingredient: ingredient.ingredient,
          role: ingredient.role,
          amount: ingredient.amount,
          unit: ingredient.unit,
        })),
      ),
    },
  }));

  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));

  for (const [id, payload] of Object.entries(movesJson.movesByCocktail || {})) {
    if (!adjacency.has(id)) continue;
    const moves = (payload.moves || [])
      .map((move) => {
        const targetId = move.targetId || move.to;
        if (!targetId || !nodesById.has(targetId)) return null;
        return {
          targetId,
          targetName: move.targetName || nodesById.get(targetId)?.name || "Unknown",
          moveType: move.moveType || "global",
          score: Number(move.score) || 0,
          description: move.description || "",
          direction: move.direction || "misc",
          radius: move.radius || "outer",
          diff: Array.isArray(move.diff) ? move.diff : [],
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        const moveDelta = (moveOrder[left.moveType] ?? 99) - (moveOrder[right.moveType] ?? 99);
        if (moveDelta !== 0) return moveDelta;
        if (right.score !== left.score) return right.score - left.score;
        return left.targetName.localeCompare(right.targetName);
      });
    adjacency.set(id, moves);
  }

  const edgeKeySet = new Set(
    (graphJson.edges || [])
      .map((edge) => {
        if (!edge.from || !edge.to) return null;
        return pairKey(edge.from, edge.to);
      })
      .filter(Boolean),
  );

  const searchable = nodes
    .map((node) => ({
      id: node.id,
      name: node.name,
      nameLower: lc(node.name),
      ingredients: node.features.items.map((item) => item.ingredient),
      ingredientsLower: node.features.items.map((item) => lc(item.ingredient)),
      searchText: lc([node.name, ...node.features.items.map((item) => item.ingredient)].join(" ")),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { nodes, nodesById, adjacency, edgeKeySet, searchable };
}

function chooseInitialId() {
  const candidates = state.graphData.nodes.filter((node) => (state.graphData.adjacency.get(node.id) || []).length >= 5);
  return choice(candidates.length ? candidates : state.graphData.nodes).id;
}

function isFavorite(id) {
  return state.favoriteIds.includes(id);
}

function favoriteNodes() {
  return state.favoriteIds.map((id) => byId(id)).filter(Boolean);
}

function buildIngredientRows(items, limit = 7) {
  return items
    .slice(0, limit)
    .map(
      (item) => `
        <div class="ing">
          <div class="amt">${escapeHtml(fmtAmount(item.amount, item.unit))}</div>
          <div class="name">${escapeHtml(item.ingredient)}</div>
        </div>
      `,
    )
    .join("");
}

function buildCenterCardMarkup(node) {
  const items = (node.features?.items || []).slice(0, 7);
  const saved = isFavorite(node.id);
  return `
    <div class="center-card-head">
      <div class="title">${escapeHtml(node.name)}</div>
      <button
        id="favoriteBtn"
        class="card-icon-button favorite-toggle${saved ? " is-saved" : ""}"
        type="button"
        aria-label="${saved ? "Saved to favorites" : "Add to favorites"}"
        aria-pressed="${saved ? "true" : "false"}"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            class="favorite-icon-heart"
            d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"
          ></path>
        </svg>
      </button>
    </div>
    <div class="ingredients">
      ${buildIngredientRows(items)}
    </div>
  `;
}

function renderCenter(node) {
  const card = document.getElementById("centerCard");
  card.innerHTML = buildCenterCardMarkup(node);
  const favoriteBtn = document.getElementById("favoriteBtn");
  favoriteBtn?.addEventListener("click", () => {
    if (state.isAnimating || !state.currentId || isFavorite(state.currentId)) return;
    addFavorite(state.currentId);
  });
}

function updateFavoriteButton() {
  const favoriteBtn = document.getElementById("favoriteBtn");
  if (!favoriteBtn || !state.currentId) return;
  const saved = isFavorite(state.currentId);
  favoriteBtn.classList.toggle("is-saved", saved);
  favoriteBtn.setAttribute("aria-pressed", saved ? "true" : "false");
  favoriteBtn.setAttribute("aria-label", saved ? "Saved to favorites" : "Add to favorites");
}

function buildSavedCardMarkup(node) {
  const items = (node.features?.items || []).slice(0, 4);
  return `
    <article class="saved-card" data-saved-card="${escapeHtml(node.id)}">
      <div class="saved-card-head">
        <button class="saved-card-title-button" type="button" data-open-id="${escapeHtml(node.id)}">
          <div class="saved-card-title">${escapeHtml(node.name)}</div>
        </button>
        <button
          class="card-icon-button saved-card-remove"
          type="button"
          data-remove-id="${escapeHtml(node.id)}"
          aria-label="Remove ${escapeHtml(node.name)} from saved cocktails"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18 6 6 18"></path>
            <path d="m6 6 12 12"></path>
          </svg>
        </button>
      </div>
      <button class="saved-card-link" type="button" data-open-id="${escapeHtml(node.id)}" aria-label="Open ${escapeHtml(node.name)}">
        <div class="saved-card-ingredients">
          ${buildIngredientRows(items, 4)}
        </div>
      </button>
    </article>
  `;
}

function currentSearchQuery() {
  return norm(document.getElementById("searchInput")?.value || "");
}

function searchCocktails(query, limit = SEARCH_LIMIT) {
  const normalized = lc(query);
  if (!normalized || !state.graphData) return [];
  const tokens = normalized.split(" ").filter(Boolean);

  return state.graphData.searchable
    .map((entry) => {
      if (!tokens.every((token) => entry.searchText.includes(token))) return null;

      const nameContainsAllTokens = tokens.every((token) => entry.nameLower.includes(token));
      const matchingIngredients = entry.ingredients.filter((ingredient, index) =>
        tokens.some((token) => entry.ingredientsLower[index].includes(token)),
      );

      let tier = 6;
      if (entry.nameLower === normalized) tier = 0;
      else if (entry.nameLower.startsWith(normalized)) tier = 1;
      else if (nameContainsAllTokens) tier = 2;
      else if (entry.nameLower.includes(normalized)) tier = 3;
      else if (entry.ingredientsLower.some((ingredient) => ingredient.startsWith(normalized))) tier = 4;
      else if (entry.ingredientsLower.some((ingredient) => ingredient.includes(normalized))) tier = 5;

      const nameIndex = entry.nameLower.indexOf(normalized);

      return {
        id: entry.id,
        node: byId(entry.id),
        tier,
        nameIndex: nameIndex === -1 ? 999 : nameIndex,
        matchingIngredients: [...new Set(matchingIngredients)],
      };
    })
    .filter((result) => result?.node)
    .sort((left, right) => {
      if (left.tier !== right.tier) return left.tier - right.tier;
      if (left.nameIndex !== right.nameIndex) return left.nameIndex - right.nameIndex;
      if (left.matchingIngredients.length !== right.matchingIngredients.length) {
        return right.matchingIngredients.length - left.matchingIngredients.length;
      }
      return left.node.name.localeCompare(right.node.name);
    })
    .slice(0, limit);
}

function buildSearchResultMarkup(result) {
  const matchingIngredientSet = new Set(result.matchingIngredients.map((ingredient) => lc(ingredient)));
  const matchedItems = [];
  const remainingItems = [];

  for (const item of result.node.features.items || []) {
    if (matchingIngredientSet.has(lc(item.ingredient))) matchedItems.push(item);
    else remainingItems.push(item);
  }

  const items = [...matchedItems, ...remainingItems].slice(0, 4);
  return `
    <article class="saved-card search-result-card" data-search-card="${escapeHtml(result.id)}">
      <button class="saved-card-link search-result-link" type="button" data-search-open-id="${escapeHtml(result.id)}" aria-label="Open ${escapeHtml(result.node.name)}">
        <div class="saved-card-title">${escapeHtml(result.node.name)}</div>
        <div class="saved-card-ingredients">
          ${buildIngredientRows(items, 4)}
        </div>
      </button>
    </article>
  `;
}

function renderFavoritesPanel() {
  const list = document.getElementById("favoritesList");
  const nodes = favoriteNodes();

  if (!nodes.length) {
    list.innerHTML = `
      <div class="favorites-empty">
        <p class="favorites-empty-copy">
          Tap the
          <span class="favorites-inline-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"></path>
            </svg>
          </span>
          on cocktails you like to add them here.
        </p>
      </div>
    `;
    return;
  }

  list.innerHTML = nodes.map((node) => buildSavedCardMarkup(node)).join("");
}

function updateFavoritesToggleButton() {
  const listToggleBtn = document.getElementById("listToggleBtn");
  listToggleBtn.setAttribute("aria-expanded", state.favoritesOpen ? "true" : "false");
  listToggleBtn.classList.toggle("is-active", state.favoritesOpen);
}

function renderSearchPanel() {
  const panel = document.getElementById("searchPanel");
  const list = document.getElementById("searchResults");
  const query = currentSearchQuery();

  if (!state.searchOpen || !query) {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    list.innerHTML = "";
    return;
  }

  const results = searchCocktails(query);
  panel.hidden = false;
  panel.setAttribute("aria-hidden", "false");

  if (!results.length) {
    list.innerHTML = `
      <div class="favorites-empty">
        <p class="favorites-empty-copy">No cocktails matched “${escapeHtml(query)}”. Try a cocktail name or an ingredient.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = results.map((result) => buildSearchResultMarkup(result)).join("");
}

function setFavoritesOpen(isOpen) {
  const app = document.getElementById("app");
  const backdrop = document.getElementById("favoritesBackdrop");
  const panel = document.getElementById("favoritesPanel");

  state.favoritesOpen = isOpen;
  app.dataset.favoritesOpen = isOpen ? "true" : "false";
  backdrop.hidden = !isOpen;
  panel.hidden = !isOpen;
  panel.setAttribute("aria-hidden", isOpen ? "false" : "true");

  if (isOpen) {
    renderFavoritesPanel();
  }

  updateFavoritesToggleButton();
}

function updateFavoritesUi() {
  updateFavoriteButton();
  renderFavoritesPanel();
  updateFavoritesToggleButton();
}

function addFavorite(id) {
  if (!id || isFavorite(id)) {
    updateFavoritesUi();
    return;
  }

  syncFavoriteIds([id, ...state.favoriteIds]);
  updateFavoritesUi();
  setStatus(`${byId(id)?.name || "Cocktail"} saved.`);
}

function removeFavorite(id) {
  if (!isFavorite(id)) return;
  syncFavoriteIds(state.favoriteIds.filter((favoriteId) => favoriteId !== id));
  updateFavoritesUi();
}

function buildDisplayMoves(currentNode) {
  const allMoves = state.graphData.adjacency.get(currentNode.id) || [];
  const filtered = allMoves.filter((move) => byId(move.targetId));
  const buckets = { local_small: [], local_large: [], global: [] };
  filtered.forEach((move) => {
    const key = move.moveType in buckets ? move.moveType : "global";
    buckets[key].push(move);
  });

  const selected = [];
  ["local_small", "local_large", "global"].forEach((type) => {
    selected.push(...buckets[type].slice(0, 3));
  });

  const unique = [];
  const seen = new Set();
  for (const move of selected) {
    if (seen.has(move.targetId)) continue;
    seen.add(move.targetId);
    unique.push(move);
  }
  return unique.slice(0, DISPLAY_LIMIT);
}

function angleForDirection(direction, index, totalInBucket) {
  const baseMap = {
    up: -90,
    right: 0,
    down: 90,
    left: 180,
    down_right: 45,
    down_left: 135,
    misc: -35,
  };
  const base = baseMap[direction] ?? -35;
  const spread = totalInBucket <= 1 ? 0 : Math.min(56, 20 + totalInBucket * 8);
  const offset = totalInBucket <= 1 ? 0 : index / (totalInBucket - 1) - 0.5;
  return ((base + offset * spread) * Math.PI) / 180;
}

function clampValue(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let nextSeed = seed >>> 0;
  return () => {
    nextSeed = (nextSeed + 0x6d2b79f5) >>> 0;
    let t = nextSeed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeAngle(angle) {
  let next = angle;
  while (next <= -Math.PI) next += Math.PI * 2;
  while (next > Math.PI) next -= Math.PI * 2;
  return next;
}

function lerpAngle(from, to, amount) {
  const delta = normalizeAngle(to - from);
  return normalizeAngle(from + delta * amount);
}

function aspectLayoutBias() {
  const aspect = window.innerWidth / Math.max(window.innerHeight, 1);

  if (aspect < 0.82) {
    return {
      axis: "vertical",
      strength: clampValue((0.82 - aspect) / 0.34, 0.18, 0.58),
    };
  }

  if (aspect > 1.65) {
    return {
      axis: "horizontal",
      strength: clampValue((aspect - 1.65) / 0.7, 0.18, 0.58),
    };
  }

  return { axis: "none", strength: 0 };
}

function targetBiasAngle(direction, axis, index) {
  const alternateVertical = index % 2 === 0 ? -Math.PI / 2 : Math.PI / 2;
  const alternateHorizontal = index % 2 === 0 ? Math.PI : 0;

  if (axis === "vertical") {
    switch (direction) {
      case "up":
        return -Math.PI / 2;
      case "down":
      case "down_right":
      case "down_left":
        return Math.PI / 2;
      case "right":
        return index % 2 === 0 ? Math.PI / 2 : -Math.PI / 2;
      case "left":
        return index % 2 === 0 ? -Math.PI / 2 : Math.PI / 2;
      default:
        return alternateVertical;
    }
  }

  if (axis === "horizontal") {
    switch (direction) {
      case "right":
      case "down_right":
        return 0;
      case "left":
      case "down_left":
        return Math.PI;
      case "up":
        return index % 2 === 0 ? Math.PI : 0;
      case "down":
        return index % 2 === 0 ? 0 : Math.PI;
      default:
        return alternateHorizontal;
    }
  }

  return 0;
}

function applyViewportBias(angle, direction, index) {
  const bias = aspectLayoutBias();
  if (bias.axis === "none" || bias.strength <= 0) {
    return angle;
  }

  const target = targetBiasAngle(direction, bias.axis, index);
  return lerpAngle(angle, target, bias.strength);
}

function backgroundLightTargets(nodeId) {
  const random = mulberry32(hashString(nodeId || "cocktails"));
  const aspect = window.innerWidth / Math.max(window.innerHeight, 1);
  const portrait = aspect < 0.95;
  const landscape = aspect > 1.3;

  const anchors = portrait
    ? [
        { x: [10, 24], y: [8, 22] },
        { x: [34, 64], y: [30, 52] },
        { x: [70, 88], y: [10, 24] },
      ]
    : landscape
      ? [
          { x: [8, 24], y: [14, 30] },
          { x: [36, 60], y: [30, 50] },
          { x: [68, 90], y: [10, 26] },
        ]
      : [
          { x: [10, 24], y: [10, 22] },
          { x: [38, 62], y: [32, 52] },
          { x: [72, 88], y: [12, 26] },
        ];

  return anchors.map((anchor, index) => {
    const x = lerp(anchor.x[0], anchor.x[1], random());
    const y = lerp(anchor.y[0], anchor.y[1], random());
    const scale = lerp(0.92, 1.34, random());
    const opacity = lerp(index === 1 ? 0.2 : 0.16, index === 1 ? 0.34 : 0.28, random());
    return { x, y, scale, opacity };
  });
}

function repositionBackgroundLights(nodeId) {
  const lights = [...document.querySelectorAll(".background-light")];
  const targets = backgroundLightTargets(nodeId);

  lights.forEach((light, index) => {
    const target = targets[index];
    if (!target) return;
    light.style.left = `${target.x}%`;
    light.style.top = `${target.y}%`;
    light.style.transform = `translate(-50%, -50%) scale(${target.scale})`;
    light.style.opacity = `${target.opacity}`;
  });
}

function radiusForMoveType(type) {
  const styles = getComputedStyle(document.documentElement);
  if (type === "local_small") return parseFloat(styles.getPropertyValue("--radius-inner"));
  if (type === "local_large") return parseFloat(styles.getPropertyValue("--radius-middle"));
  return parseFloat(styles.getPropertyValue("--radius-outer"));
}

function clampNodePosition(x, y, width, height, centerRect) {
  const edgePadding = window.innerWidth <= 700 ? 24 : 18;
  const topPadding = window.innerWidth <= 700 ? 114 : 92;
  const bottomPadding = window.innerWidth <= 700 ? 28 : 22;
  const minX = width * 0.5 + edgePadding;
  const maxX = window.innerWidth - width * 0.5 - edgePadding;
  const minY = height * 0.5 + topPadding;
  const maxY = window.innerHeight - height * 0.5 - bottomPadding;

  let nextX = Math.max(minX, Math.min(maxX, x));
  let nextY = Math.max(minY, Math.min(maxY, y));

  if (centerRect) {
    const pad = 28;
    const left = centerRect.left - width * 0.5 - pad;
    const right = centerRect.right + width * 0.5 + pad;
    const top = centerRect.top - height * 0.5 - pad;
    const bottom = centerRect.bottom + height * 0.5 + pad;

    if (nextX > left && nextX < right && nextY > top && nextY < bottom) {
      const dxLeft = Math.abs(nextX - left);
      const dxRight = Math.abs(right - nextX);
      const dyTop = Math.abs(nextY - top);
      const dyBottom = Math.abs(bottom - nextY);
      const minDelta = Math.min(dxLeft, dxRight, dyTop, dyBottom);

      if (minDelta === dxLeft) nextX = left;
      else if (minDelta === dxRight) nextX = right;
      else if (minDelta === dyTop) nextY = top;
      else nextY = bottom;
    }
  }

  return { x: nextX, y: nextY };
}

function drawLine(svg, x1, y1, x2, y2, mode = "normal") {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", x1);
  line.setAttribute("y1", y1);
  line.setAttribute("x2", x2);
  line.setAttribute("y2", y2);
  line.setAttribute(
    "stroke",
    mode === "secondary"
      ? "rgba(170,195,255,0.16)"
      : mode === "outer"
        ? "rgba(214,163,255,0.36)"
        : "rgba(170,195,255,0.28)",
  );
  line.setAttribute("stroke-width", mode === "secondary" ? "1.25" : "1.8");
  line.setAttribute("stroke-linecap", "round");
  svg.appendChild(line);
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function finishAnimation(animation) {
  if (!animation) return Promise.resolve();
  return animation.finished.catch(() => {});
}

function cancelAnimations(element) {
  if (!element) return;
  element.getAnimations().forEach((animation) => animation.cancel());
}

function createMoveNodeElement() {
  const nodeEl = document.createElement("button");
  nodeEl.type = "button";
  nodeEl.className = "move-node";
  return nodeEl;
}

function syncMoveNodeElement(nodeEl, move) {
  nodeEl.className = `move-node ${move.moveType}`;
  nodeEl.innerHTML = `<div class="name">${escapeHtml(move.targetName)}</div>`;
  nodeEl.dataset.nodeId = move.targetId;
}

function animateNodeEnter(nodeEl) {
  cancelAnimations(nodeEl);
  if (prefersReducedMotion()) return Promise.resolve();
  return finishAnimation(
    nodeEl.animate(
      [
        { opacity: 0, transform: "translate(-50%, -50%) scale(0.92)" },
        { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
      ],
      {
        duration: 260,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    ),
  );
}

function animateNodeMove(nodeEl, from, to) {
  cancelAnimations(nodeEl);
  if (!from || prefersReducedMotion()) return Promise.resolve();

  const dx = from.x - to.x;
  const dy = from.y - to.y;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return Promise.resolve();

  return finishAnimation(
    nodeEl.animate(
      [
        { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px)` },
        { transform: "translate(-50%, -50%) translate(0px, 0px)" },
      ],
      {
        duration: 360,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    ),
  );
}

function animateNodeExit(nodeEl) {
  cancelAnimations(nodeEl);
  if (prefersReducedMotion()) {
    nodeEl.remove();
    return Promise.resolve();
  }

  return finishAnimation(
    nodeEl.animate(
      [
        { opacity: 1, transform: "translate(-50%, -50%) scale(1)" },
        { opacity: 0, transform: "translate(-50%, -50%) scale(0.86)" },
      ],
      {
        duration: 220,
        easing: "ease-out",
        fill: "forwards",
      },
    ),
  ).then(() => {
    nodeEl.remove();
  });
}

function animateCenterCardRefresh(centerCard) {
  cancelAnimations(centerCard);
  if (prefersReducedMotion()) return Promise.resolve();
  return finishAnimation(
    centerCard.animate(
      [
        { opacity: 0.82, transform: "translateY(8px) scale(0.985)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      {
        duration: 280,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    ),
  );
}

function animateCenterCardMorph(node, sourceEl) {
  const centerCard = document.getElementById("centerCard");
  const transitionLayer = document.getElementById("transitionLayer");
  if (!sourceEl || prefersReducedMotion()) {
    return animateCenterCardRefresh(centerCard);
  }

  const sourceRect = sourceEl.getBoundingClientRect();
  const targetRect = centerCard.getBoundingClientRect();
  const sourceStyle = getComputedStyle(sourceEl);
  const targetStyle = getComputedStyle(centerCard);
  const ghost = centerCard.cloneNode(true);
  ghost.removeAttribute("id");
  ghost.classList.add("transition-card");
  ghost.style.left = `${sourceRect.left}px`;
  ghost.style.top = `${sourceRect.top}px`;
  ghost.style.width = `${targetRect.width}px`;
  ghost.style.height = `${targetRect.height}px`;
  ghost.style.borderRadius = targetStyle.borderRadius;
  transitionLayer.appendChild(ghost);
  centerCard.classList.add("is-transition-hidden");

  const scaleX = sourceRect.width / Math.max(targetRect.width, 1);
  const scaleY = sourceRect.height / Math.max(targetRect.height, 1);
  const translateX = sourceRect.left - targetRect.left;
  const translateY = sourceRect.top - targetRect.top;
  const animation = ghost.animate(
    [
      {
        left: `${targetRect.left}px`,
        top: `${targetRect.top}px`,
        width: `${targetRect.width}px`,
        height: `${targetRect.height}px`,
        borderRadius: sourceStyle.borderRadius,
        transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
        opacity: 0.96,
      },
      {
        left: `${targetRect.left}px`,
        top: `${targetRect.top}px`,
        width: `${targetRect.width}px`,
        height: `${targetRect.height}px`,
        borderRadius: targetStyle.borderRadius,
        transform: "translate(0px, 0px) scale(1, 1)",
        opacity: 1,
      },
    ],
    {
      duration: 420,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      fill: "forwards",
    },
  );

  return finishAnimation(animation).then(() => {
    ghost.remove();
    centerCard.classList.remove("is-transition-hidden");
  });
}

function drawConnections(svg, centerX, centerY) {
  svg.innerHTML = "";

  for (const [, position] of state.nodePositions.entries()) {
    drawLine(svg, centerX, centerY, position.x, position.y, position.move.moveType === "global" ? "outer" : "normal");
  }

  const ids = [...state.nodePositions.keys()];
  for (let index = 0; index < ids.length; index += 1) {
    for (let inner = index + 1; inner < ids.length; inner += 1) {
      const leftId = ids[index];
      const rightId = ids[inner];
      if (!state.graphData.edgeKeySet.has(pairKey(leftId, rightId))) continue;
      const left = state.nodePositions.get(leftId);
      const right = state.nodePositions.get(rightId);
      drawLine(svg, left.x, left.y, right.x, right.y, "secondary");
    }
  }

  cancelAnimations(svg);
  if (!prefersReducedMotion()) {
    svg.animate(
      [{ opacity: 0.18 }, { opacity: 1 }],
      {
        duration: 220,
        easing: "ease-out",
      },
    );
  }
}

async function renderGraph(currentNode, options = {}) {
  const { sourceId = null } = options;
  const layer = document.getElementById("nodesLayer");
  const svg = document.getElementById("lines");
  const previousPositions = new Map(state.nodePositions);
  const previousNodes = new Map(state.nodeElements);
  const sourceEl = sourceId ? previousNodes.get(sourceId) ?? null : null;
  const moves = buildDisplayMoves(currentNode);

  renderCenter(currentNode);
  const centerWrap = document.querySelector(".center-wrap");
  const centerRect = centerWrap.getBoundingClientRect();
  const centerX = centerRect.left + centerRect.width / 2;
  const centerY = centerRect.top + centerRect.height / 2;

  if (!moves.length) {
    const exitAnimations = [];
    for (const [id, nodeEl] of previousNodes.entries()) {
      if (id === sourceId) continue;
      exitAnimations.push(animateNodeExit(nodeEl));
    }
    state.nodeElements = new Map();
    state.nodePositions = new Map();
    svg.innerHTML = "";
    const centerAnimation = animateCenterCardMorph(currentNode, sourceEl);
    if (sourceEl) {
      cancelAnimations(sourceEl);
      sourceEl.style.opacity = "0";
      sourceEl.style.pointerEvents = "none";
    }
    await Promise.all([...exitAnimations, centerAnimation]);
    if (sourceEl?.isConnected) sourceEl.remove();
    setStatus(`No mapped moves from ${currentNode.name} yet. Try Random or search for another cocktail.`);
    return;
  }

  const nextNodeElements = new Map();
  const nextNodePositions = new Map();
  const groups = {};
  for (const move of moves) {
    if (!groups[move.direction]) groups[move.direction] = [];
    groups[move.direction].push(move);
  }

  const arranged = [];
  for (const [direction, bucket] of Object.entries(groups)) {
    bucket.forEach((move, index) => arranged.push({ move, localIndex: index, bucketSize: bucket.length }));
  }
  arranged.sort((left, right) => {
    const moveDelta = (moveOrder[left.move.moveType] ?? 99) - (moveOrder[right.move.moveType] ?? 99);
    if (moveDelta !== 0) return moveDelta;
    return right.move.score - left.move.score;
  });

  const simNodes = [];
  arranged.forEach((entry, index) => {
    const baseAngle = angleForDirection(entry.move.direction, entry.localIndex, entry.bucketSize);
    const angle = applyViewportBias(baseAngle, entry.move.direction, entry.localIndex);
    const radius = radiusForMoveType(entry.move.moveType);
    const nodeEl = previousNodes.get(entry.move.targetId) || createMoveNodeElement();
    syncMoveNodeElement(nodeEl, entry.move);
    layer.appendChild(nodeEl);
    nextNodeElements.set(entry.move.targetId, nodeEl);

    const rect = nodeEl.getBoundingClientRect();
    const point = clampNodePosition(
      centerX + Math.cos(angle) * radius,
      centerY + Math.sin(angle) * radius,
      rect.width,
      rect.height,
      centerRect,
    );

    simNodes.push({
      id: entry.move.targetId,
      move: entry.move,
      el: nodeEl,
      width: rect.width,
      height: rect.height,
      x: point.x,
      y: point.y,
      vx: 0,
      vy: 0,
      ax: Math.cos(angle),
      ay: Math.sin(angle),
      targetRadius: radius,
    });
  });

  for (let iteration = 0; iteration < 140; iteration += 1) {
    for (const node of simNodes) {
      const targetX = centerX + node.ax * node.targetRadius;
      const targetY = centerY + node.ay * node.targetRadius;
      node.vx += (targetX - node.x) * 0.006;
      node.vy += (targetY - node.y) * 0.006;

      const dx = node.x - centerX;
      const dy = node.y - centerY;
      const distance = Math.hypot(dx, dy) || 1;
      const minRadius = Math.max(centerRect.width, centerRect.height) * 0.5 + Math.max(node.width, node.height) * 0.5 + 18;
      if (distance < minRadius) {
        const push = (minRadius - distance) * 0.06;
        node.vx += (dx / distance) * push;
        node.vy += (dy / distance) * push;
      }
    }

    for (let index = 0; index < simNodes.length; index += 1) {
      for (let inner = index + 1; inner < simNodes.length; inner += 1) {
        const left = simNodes[index];
        const right = simNodes[inner];
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const overlapX = (left.width + right.width) * 0.5 + 8 - Math.abs(dx);
        const overlapY = (left.height + right.height) * 0.5 + 8 - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          const distance = Math.hypot(dx, dy) || 1;
          const push = 0.03 * Math.min(overlapX, overlapY);
          const pushX = (dx / distance) * push;
          const pushY = (dy / distance) * push;
          left.vx -= pushX;
          left.vy -= pushY;
          right.vx += pushX;
          right.vy += pushY;
        }
      }
    }

    for (const node of simNodes) {
      node.vx *= 0.88;
      node.vy *= 0.88;
      node.x += node.vx;
      node.y += node.vy;
      const point = clampNodePosition(node.x, node.y, node.width, node.height, centerRect);
      node.x = point.x;
      node.y = point.y;
    }
  }

  for (const node of simNodes) {
    node.el.style.left = `${node.x}px`;
    node.el.style.top = `${node.y}px`;
    node.el.style.opacity = "1";
    nextNodePositions.set(node.id, { x: node.x, y: node.y, move: node.move });
    node.el.onclick = () => {
      if (state.isAnimating) return;
      historyStack.push(currentNode.id);
      updateBackButton();
      void goTo(node.id, { sourceId: node.id });
    };
  }

  const animationPromises = [];
  for (const node of simNodes) {
    if (previousPositions.has(node.id)) {
      animationPromises.push(animateNodeMove(node.el, previousPositions.get(node.id), { x: node.x, y: node.y }));
    } else {
      animationPromises.push(animateNodeEnter(node.el));
    }
  }

  for (const [id, nodeEl] of previousNodes.entries()) {
    if (nextNodeElements.has(id) || id === sourceId) continue;
    animationPromises.push(animateNodeExit(nodeEl));
  }

  state.nodeElements = nextNodeElements;
  state.nodePositions = nextNodePositions;
  drawConnections(svg, centerX, centerY);

  if (sourceEl && !nextNodeElements.has(sourceId)) {
    cancelAnimations(sourceEl);
    sourceEl.style.opacity = "0";
    sourceEl.style.pointerEvents = "none";
  }

  const centerAnimation = animateCenterCardMorph(currentNode, sourceEl);
  animationPromises.push(centerAnimation);
  await Promise.all(animationPromises);

  if (sourceEl && !nextNodeElements.has(sourceId) && sourceEl.isConnected) {
    sourceEl.remove();
  }

  setStatus(
    `${moves.length} moves from ${currentNode.name}. ` +
      `${moves.filter((move) => move.moveType === "local_small").length} small, ` +
      `${moves.filter((move) => move.moveType === "local_large").length} large, ` +
      `${moves.filter((move) => move.moveType === "global").length} global.`,
  );
}

async function goTo(id, options = {}) {
  if (state.isAnimating) return;
  const node = byId(id);
  if (!node) return;
  state.isAnimating = true;
  state.currentId = id;
  setFavoritesOpen(false);
  setSearchOpen(false, { clear: true });
  repositionBackgroundLights(id);
  try {
    await renderGraph(node, options);
    updateFavoritesUi();
  } finally {
    state.isAnimating = false;
  }
}

function setSearchOpen(isOpen, options = {}) {
  const { focus = false, clear = false } = options;
  const shell = document.getElementById("searchShell");
  const input = document.getElementById("searchInput");
  const toggle = document.getElementById("searchToggleBtn");

  if (isOpen && state.favoritesOpen) {
    setFavoritesOpen(false);
  }

  state.searchOpen = isOpen;
  shell.dataset.open = isOpen ? "true" : "false";
  toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  toggle.classList.toggle("is-active", isOpen);
  input.setAttribute("aria-hidden", isOpen ? "false" : "true");

  if (!isOpen) {
    if (clear) input.value = "";
    renderSearchPanel();
    if (document.activeElement === input) input.blur();
    return;
  }

  renderSearchPanel();

  if (focus && !input.disabled) {
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }
}

function handleSearch() {
  const query = currentSearchQuery();
  if (!query) {
    setSearchOpen(false, { clear: true });
    return;
  }

  const [found] = searchCocktails(query, 1);
  if (!found) {
    setStatus(`No cocktail matched "${query}".`);
    setSearchOpen(true, { focus: true });
    renderSearchPanel();
    return;
  }

  if (found.id === state.currentId) {
    setSearchOpen(false, { clear: true });
    return;
  }

  historyStack.push(state.currentId);
  updateBackButton();
  void goTo(found.id);
}

function hookUi() {
  document.getElementById("listToggleBtn").addEventListener("click", () => {
    if (!state.graphData) return;
    if (state.searchOpen) {
      setSearchOpen(false, { clear: true });
    }
    setFavoritesOpen(!state.favoritesOpen);
  });

  document.getElementById("randomBtn").addEventListener("click", () => {
    if (state.isAnimating) return;
    historyStack.push(state.currentId);
    updateBackButton();
    void goTo(chooseInitialId());
  });

  document.getElementById("backBtn").addEventListener("click", () => {
    if (state.isAnimating) return;
    const previousId = historyStack.pop();
    updateBackButton();
    if (previousId) void goTo(previousId);
  });

  document.getElementById("searchToggleBtn").addEventListener("click", () => {
    if (!state.searchOpen) {
      setSearchOpen(true, { focus: true });
      return;
    }

    if (currentSearchQuery()) {
      handleSearch();
      return;
    }

    setSearchOpen(false, { clear: true });
  });

  document.getElementById("searchInput").addEventListener("input", () => {
    renderSearchPanel();
  });

  document.getElementById("searchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSearch();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      setSearchOpen(false, { clear: true });
    }
  });

  document.getElementById("searchInput").addEventListener("blur", () => {
    window.setTimeout(() => {
      const input = document.getElementById("searchInput");
      const shell = document.getElementById("searchShell");
      if (!state.searchOpen || shell.contains(document.activeElement)) return;
      if (!lc(input.value)) {
        setSearchOpen(false, { clear: true });
      }
    }, 120);
  });

  document.addEventListener("pointerdown", (event) => {
    const favoritesPanel = document.getElementById("favoritesPanel");
    if (state.favoritesOpen && !favoritesPanel.contains(event.target) && !document.getElementById("listToggleBtn").contains(event.target)) {
      setFavoritesOpen(false);
    }

    const shell = document.getElementById("searchShell");
    const searchPanel = document.getElementById("searchPanel");
    if (state.searchOpen && !shell.contains(event.target) && !searchPanel.contains(event.target)) {
      setSearchOpen(false, { clear: true });
    }
  });

  document.getElementById("favoritesBackdrop").addEventListener("click", () => {
    setFavoritesOpen(false);
  });

  document.getElementById("favoritesList").addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-id]");
    if (removeButton) {
      event.preventDefault();
      event.stopPropagation();
      removeFavorite(removeButton.dataset.removeId);
      return;
    }

    const openButton = event.target.closest("[data-open-id]");
    if (!openButton || state.isAnimating) return;
    const targetId = openButton.dataset.openId;
    if (!targetId) return;

    setFavoritesOpen(false);
    if (targetId === state.currentId) return;
    historyStack.push(state.currentId);
    updateBackButton();
    void goTo(targetId);
  });

  document.getElementById("searchResults").addEventListener("click", (event) => {
    const openButton = event.target.closest("[data-search-open-id]");
    if (!openButton || state.isAnimating) return;
    const targetId = openButton.dataset.searchOpenId;
    if (!targetId) return;

    if (targetId === state.currentId) {
      setSearchOpen(false, { clear: true });
      return;
    }

    historyStack.push(state.currentId);
    updateBackButton();
    void goTo(targetId);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.favoritesOpen) {
      setFavoritesOpen(false);
      return;
    }

    if (event.key === "Escape" && state.searchOpen) {
      setSearchOpen(false, { clear: true });
    }
  });

  window.addEventListener("resize", () => {
    if (state.currentId) {
      repositionBackgroundLights(state.currentId);
      void renderGraph(byId(state.currentId));
    }
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("Service worker registration failed", error);
  }
}

async function bootstrap() {
  setAppState("loading", "Loading cocktail graph…");
  setStatus("Loading cocktail graph…");

  try {
    const [graphJson, movesJson] = await Promise.all([fetchJson(DATA_URLS.graph), fetchJson(DATA_URLS.moves)]);
    state.graphData = buildGraphData(graphJson, movesJson);
    syncFavoriteIds(readFavoriteIds());
    hookUi();
    setControlsEnabled(true);
    await goTo(chooseInitialId());
    setAppState("ready");
    registerServiceWorker();
  } catch (error) {
    console.error(error);
    setAppState("error", "Unable to load the cocktail data.");
    setStatus("Unable to load the cocktail data. Serve this folder over HTTP and try again.");
    document.getElementById("centerCard").innerHTML = `
      <div class="title">Unable to load the constellation</div>
      <p class="helper-copy">Serve the repo from a local web server so the app can fetch the JSON files.</p>
    `;
  }
}

bootstrap();
