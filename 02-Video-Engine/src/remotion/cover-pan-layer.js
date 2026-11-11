function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function resolveCoverPanLayer({ viewportWidth, viewportHeight, imageWidth, imageHeight, panViewportWidth, panViewportHeight, scale = 1, x = 0, y = 0 }) {
  const safeViewportWidth = finitePositive(viewportWidth, 1);
  const safeViewportHeight = finitePositive(viewportHeight, 1);
  const safePanViewportHeight = finitePositive(panViewportHeight, safeViewportHeight);
  const safePanViewportWidth = finitePositive(panViewportWidth, safePanViewportHeight * (safeViewportWidth / safeViewportHeight));
  const safeImageWidth = finitePositive(imageWidth, safeViewportWidth);
  const safeImageHeight = finitePositive(imageHeight, safeViewportHeight);
  const safeScale = finitePositive(scale, 1);
  const panScale = safeViewportWidth / safePanViewportWidth;
  const requestedX = finiteNumber(x, 0) * panScale;
  const requestedY = finiteNumber(y, 0) * panScale;

  const coverScale = Math.max(safeViewportWidth / safeImageWidth, safeViewportHeight / safeImageHeight);
  const baseWidth = safeImageWidth * coverScale;
  const baseHeight = safeImageHeight * coverScale;
  const baseLeft = (safeViewportWidth - baseWidth) / 2;
  const baseTop = (safeViewportHeight - baseHeight) / 2;
  const layerWidth = baseWidth * safeScale;
  const layerHeight = baseHeight * safeScale;
  const maxX = Math.max(0, (layerWidth - safeViewportWidth) / 2);
  const maxY = Math.max(0, (layerHeight - safeViewportHeight) / 2);

  return {
    coverScale,
    baseWidth,
    baseHeight,
    baseLeft,
    baseTop,
    layerWidth,
    layerHeight,
    maxX,
    maxY,
    appliedX: requestedX,
    appliedY: requestedY,
    left: (safeViewportWidth - layerWidth) / 2 + requestedX,
    top: (safeViewportHeight - layerHeight) / 2 + requestedY,
    transformX: requestedX,
    transformY: requestedY,
    transformScale: safeScale,
  };
}

module.exports = { resolveCoverPanLayer };
