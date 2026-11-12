export type MotionSource = {
  fromScale?: number;
  toScale?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
};

export const resolveMotionRange = (motion?: MotionSource | string | null) => {
  if (motion && typeof motion === "object") {
    return {
      fromScale: motion.fromScale ?? 1,
      toScale: motion.toScale ?? 1,
      fromX: motion.fromX ?? 0,
      fromY: motion.fromY ?? 0,
      toX: motion.toX ?? 0,
      toY: motion.toY ?? 0,
    };
  }
  const normalized = (motion || "").toString().trim().toLowerCase();

  if (normalized === "still" || normalized === "none") return { fromScale: 1, toScale: 1, fromX: 0, fromY: 0, toX: 0, toY: 0 };
  if (normalized === "slow-zoom") return { fromScale: 1, toScale: 1.25, fromX: 0, fromY: 0, toX: 0, toY: 0 };
  if (normalized === "slow-zoom-out") return { fromScale: 1.08, toScale: 1, fromX: 0, fromY: 0, toX: 0, toY: 0 };
  if (normalized === "slow-zoom-in") return { fromScale: 1, toScale: 1.25, fromX: 0, fromY: 0, toX: 0, toY: 0 };
  if (normalized === "pan-left") return { fromScale: 1.1, toScale: 1.1, fromX: 72, fromY: 0, toX: -72, toY: 0 };
  if (normalized === "pan-right") return { fromScale: 1.1, toScale: 1.1, fromX: -72, fromY: 0, toX: 72, toY: 0 };

  // Unknown values fallback to slow-zoom-in.
  return { fromScale: 1, toScale: 1.25, fromX: 0, fromY: 0, toX: 0, toY: 0 };
};
