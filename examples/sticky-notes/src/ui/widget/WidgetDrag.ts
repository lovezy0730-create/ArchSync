export interface Point {
  x: number;
  y: number;
}

/** 纯函数：限制便签窗口拖拽位置在虚拟桌面范围内。 */
export function clampToDesktop(p: Point, desktop: { width: number; height: number }): Point {
  return {
    x: Math.max(0, Math.min(p.x, desktop.width)),
    y: Math.max(0, Math.min(p.y, desktop.height)),
  };
}
