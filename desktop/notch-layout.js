export function notchBounds(display, size) {
  const { bounds } = display;
  return {
    x: Math.round(bounds.x + (bounds.width - size.w) / 2),
    y: bounds.y,
    width: size.w,
    height: size.h,
  };
}

export function notchSafeTop(display, platform) {
  return platform === 'darwin' ? Math.max(0, display.workArea.y - display.bounds.y) : 0;
}

export function overNotchIsland(bounds, island, point) {
  if (!island) return false;
  const cx = bounds.x + bounds.width / 2;
  const top = bounds.y + (island.y ?? 0);
  return point.x >= cx - island.w / 2 - 1 && point.x <= cx + island.w / 2 + 1
    && point.y >= top - 1 && point.y <= top + island.h + 1;
}
