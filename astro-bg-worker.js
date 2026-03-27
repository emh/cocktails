self.onmessage = (event) => {
  const message = event.data;
  if (message?.type !== "render") return;

  if (typeof OffscreenCanvas === "undefined") {
    self.postMessage({ type: "unsupported" });
    return;
  }

  const { width, height, dpr, scene } = message;
  const renderWidth = Math.max(1, Math.floor(width * dpr));
  const renderHeight = Math.max(1, Math.floor(height * dpr));

  const background = new OffscreenCanvas(renderWidth, renderHeight);
  const midground = new OffscreenCanvas(renderWidth, renderHeight);
  const foreground = new OffscreenCanvas(renderWidth, renderHeight);

  renderBackground(background.getContext("2d", { alpha: false }), renderWidth, renderHeight, scene);
  renderMidground(midground.getContext("2d", { alpha: true }), renderWidth, renderHeight, scene);
  renderForeground(foreground.getContext("2d", { alpha: true }), renderWidth, renderHeight, scene);

  const layers = [
    background.transferToImageBitmap(),
    midground.transferToImageBitmap(),
    foreground.transferToImageBitmap(),
  ];

  self.postMessage({ type: "frame", layers }, layers);
};

function mulberry32(seed) {
  let nextSeed = seed >>> 0;
  return () => {
    nextSeed = (nextSeed + 0x6d2b79f5) >>> 0;
    let value = nextSeed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function smoothstep(a, b, value) {
  const amount = clamp((value - a) / (b - a), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

function rgba(rgb, alpha) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function mixRgb(left, right, amount) {
  return [
    Math.round(lerp(left[0], right[0], amount)),
    Math.round(lerp(left[1], right[1], amount)),
    Math.round(lerp(left[2], right[2], amount)),
  ];
}

function hash2(x, y, seed) {
  let hash = Math.imul((x | 0) ^ 374761393, 668265263);
  hash = Math.imul(hash ^ ((y | 0) + ((seed * 1597334677) | 0)), 2246822519);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489917);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = x - x0;
  const ty = y - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x1, y0, seed);
  const n01 = hash2(x0, y1, seed);
  const n11 = hash2(x1, y1, seed);
  const nx0 = n00 + (n10 - n00) * sx;
  const nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy;
}

function fbm(x, y, seed, octaves = 5) {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let normalization = 0;
  for (let index = 0; index < octaves; index += 1) {
    sum += valueNoise(x * frequency, y * frequency, seed + index * 977) * amplitude;
    normalization += amplitude;
    frequency *= 2.01;
    amplitude *= 0.5;
  }
  return sum / normalization;
}

function domainWarp(x, y, seed) {
  const qx = fbm(x * 1.15 + 8.3, y * 1.15 + 2.1, seed + 101, 4);
  const qy = fbm(x * 1.15 - 5.9, y * 1.15 + 7.4, seed + 173, 4);
  return fbm(x + (qx - 0.5) * 1.35, y + (qy - 0.5) * 1.35, seed + 233, 5);
}

function sampleStarAlpha(random, tier) {
  if (tier === 0) return 0.03 + Math.pow(random(), 1.8) * 0.08;
  if (tier === 1) return 0.05 + Math.pow(random(), 1.5) * 0.13;
  return 0.08 + Math.pow(random(), 1.2) * 0.19;
}

function starColor(random, base) {
  const amount = random();
  if (amount < 0.72) return base;
  if (amount < 0.9) return mixRgb(base, [180, 205, 240], 0.52);
  return mixRgb(base, [255, 221, 190], 0.42);
}

function renderBackground(ctx, width, height, scene) {
  const random = mulberry32(scene.seed);
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const background = scene.palette.bg;
  const haze1 = scene.palette.haze1;
  const haze2 = scene.palette.haze2;
  const cosAngle = Math.cos(scene.dustAngle);
  const sinAngle = Math.sin(scene.dustAngle);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const nx = x / width - 0.5;
      const ny = y / height - 0.5;
      const ry = -nx * sinAngle + ny * cosAngle;
      const warp = domainWarp(nx * 3.2, ny * 3.2, scene.seed + 47);
      const cloud = fbm(nx * 2.2 + 20.1, ny * 2.2 - 7.4, scene.seed + 89, 5);
      const fine = fbm(nx * 6.5 - 4.3, ny * 6.5 + 1.7, scene.seed + 121, 4);

      const bandBase = 1 - smoothstep(scene.bandWidth * 0.35, scene.bandWidth, Math.abs(ry - (scene.bandY - 0.5)));
      const haze = clamp((warp * 0.7 + cloud * 0.6 - 0.42) * 1.6, 0, 1);
      const filaments = Math.pow(1 - Math.abs(2 * fine - 1), 2.6);
      const structured = clamp(haze * 0.9 + bandBase * 0.6 + filaments * 0.25 - 0.02, 0, 1);
      const dust = clamp((filaments * 0.9 + bandBase * 0.6 - haze * 0.15) * scene.dustStrength, 0, 1);
      const tone = mixRgb(haze1, haze2, clamp(structured * 1.1, 0, 1));

      const backgroundGradient = 0.03 + 0.08 * (1 - Math.hypot(nx * 1.05, ny * 1.1));
      let red = background[0] + tone[0] * structured * scene.hazeStrength + backgroundGradient * 8;
      let green = background[1] + tone[1] * structured * scene.hazeStrength + backgroundGradient * 10;
      let blue = background[2] + tone[2] * structured * scene.hazeStrength + backgroundGradient * 14;

      red = lerp(red, background[0], dust * 0.38);
      green = lerp(green, background[1], dust * 0.38);
      blue = lerp(blue, background[2], dust * 0.42);

      const vignette = 1 - scene.vignette * Math.pow(Math.hypot(nx / 0.82, ny / 0.82), 1.65);
      const grain = (random() - 0.5) * 255 * scene.grain;

      data[index] = clamp(red * vignette + grain, 0, 255);
      data[index + 1] = clamp(green * vignette + grain, 0, 255);
      data[index + 2] = clamp(blue * vignette + grain * 1.1, 0, 255);
      data[index + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);

  const glowX = width * (0.3 + random() * 0.4);
  const glowY = height * (0.25 + random() * 0.5);
  const glowRadius = Math.min(width, height) * (0.45 + random() * 0.2);
  const gradient = ctx.createRadialGradient(glowX, glowY, 0, glowX, glowY, glowRadius);
  gradient.addColorStop(0, rgba(mixRgb(haze1, haze2, 0.5), 0.03));
  gradient.addColorStop(0.5, rgba(haze2, 0.015));
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawStars(ctx, random, count, tier, width, height, starBase) {
  for (let index = 0; index < count; index += 1) {
    const x = random() * width;
    const y = random() * height;
    const alpha = sampleStarAlpha(random, tier);
    const size = tier === 0 ? (random() < 0.94 ? 0.45 : 0.8) : tier === 1 ? (random() < 0.88 ? 0.55 : 1.05) : (random() < 0.82 ? 0.75 : 1.4);
    const color = starColor(random, starBase);
    ctx.beginPath();
    ctx.fillStyle = rgba(color, alpha);
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderMidground(ctx, width, height, scene) {
  const random = mulberry32(scene.seed + 1009);
  ctx.globalCompositeOperation = "screen";
  drawStars(ctx, random, scene.starCountFar, 0, width, height, scene.palette.star);
  drawStars(ctx, random, scene.starCountMid, 1, width, height, scene.palette.star);

  const cloudCount = 5 + ((random() * 5) | 0);
  for (let index = 0; index < cloudCount; index += 1) {
    const x = random() * width;
    const y = random() * height;
    const radius = Math.min(width, height) * (0.12 + random() * 0.18);
    const color = mixRgb(scene.palette.haze1, scene.palette.haze2, random());
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, rgba(color, 0.03 + random() * 0.014));
    gradient.addColorStop(0.5, rgba(color, 0.016 + random() * 0.012));
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
}

function renderForeground(ctx, width, height, scene) {
  const random = mulberry32(scene.seed + 2027);
  ctx.globalCompositeOperation = "screen";
  drawStars(ctx, random, scene.starCountNear, 2, width, height, scene.palette.star);

  for (let index = 0; index < scene.brightCount; index += 1) {
    const x = random() * width;
    const y = random() * height;
    const size = 1.5 + random() * 2.2;
    const color = starColor(random, scene.palette.star);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, size * 8);
    gradient.addColorStop(0, rgba(color, 0.15));
    gradient.addColorStop(0.2, rgba(color, 0.04));
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(x - size * 8, y - size * 8, size * 16, size * 16);

    ctx.beginPath();
    ctx.fillStyle = "rgba(255,255,255,0.62)";
    ctx.arc(x, y, size * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }
}
