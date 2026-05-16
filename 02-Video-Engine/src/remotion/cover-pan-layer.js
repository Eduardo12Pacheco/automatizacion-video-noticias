function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveCoverPanLayer({ viewportWidth, viewportHeight, imageWidth, imageHeight, scale = 1, x = 0, y = 0 }) {
  const safeViewportWidth = finitePositive(viewportWidth, 1);
  const safeViewportHeight = finitePositive(viewportHeight, 1);
  const safeImageWidth = finitePositive(imageWidth, safeViewportWidth);
  const safeImageHeight = finitePositive(imageHeight, safeViewportHeight);
  const safeScale = finitePositive(scale, 1);
  const requestedX = finiteNumber(x, 0);
  const requestedY = finiteNumber(y, 0);

  const coverScale = Math.max(safeViewportWidth / safeImageWidth, safeViewportHeight / safeImageHeight);
  const baseWidth = safeImageWidth * coverScale;
  const baseHeight = safeImageHeight * coverScale;
  const layerWidth = baseWidth * safeScale;
  const layerHeight = baseHeight * safeScale;
  const maxX = Math.max(0, (layerWidth - safeViewportWidth) / 2);
  const maxY = Math.max(0, (layerHeight - safeViewportHeight) / 2);
  const clampedX = clamp(requestedX, -maxX, maxX);
  const clampedY = clamp(requestedY, -maxY, maxY);

  return {
    coverScale,
    baseWidth,
    baseHeight,
    layerWidth,
    layerHeight,
    maxX,
    maxY,
    clampedX,
    clampedY,
    left: (safeViewportWidth - layerWidth) / 2 + clampedX,
    top: (safeViewportHeight - layerHeight) / 2 + clampedY,
  };
}

module.exports = { resolveCoverPanLayer };
