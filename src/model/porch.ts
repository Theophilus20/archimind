/**
 * Porches, verandas and decks: spaces bounded partly by handrails. How each is roofed follows
 * common practice:
 *  - a recessed (inset) porch, set into the house so its walls bound much of it, sits under the
 *    main roof and has no roof of its own;
 *  - a projecting porch, against one wall, gets its own lean-to (shed) roof sloping away from the
 *    house, carried on posts;
 *  - an open deck or patio has no roof.
 * The choice can be changed per porch; "automatic" picks recessed or projecting from the walls.
 */
import type { BuildingModel } from './types';
import type { DerivedRoom } from './derive';
import { dist, projectOnSegment } from './geometry';

export type PorchRoof = 'main' | 'own' | 'none';

export const PORCH_ROOF_LABEL: Record<PorchRoof, string> = {
  main: 'Under the main roof',
  own: 'Its own lean-to roof',
  none: 'No roof (open deck)',
};

/** A porch, veranda, deck or patio: a space with handrails on part of its edge. */
export function isPorch(model: BuildingModel, room: Pick<DerivedRoom, 'wallIds'>) {
  return room.wallIds.some((id) => model.walls.find((w) => w.id === id)?.kind === 'railing');
}

/** Share of the porch's edge that is the house's own walls. */
export function houseShare(model: BuildingModel, room: Pick<DerivedRoom, 'polygon'>) {
  const solid = model.walls.filter((w) => w.kind !== 'railing' && w.kind !== 'column');
  let onHouse = 0;
  let total = 0;
  const poly = room.polygon;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = dist(a, b);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    total += len;
    if (solid.some((w) => projectOnSegment(mid, w.a, w.b).distance < w.thickness / 2 + 40)) onHouse += len;
  }
  return total ? onHouse / total : 0;
}

/** How this porch is roofed: the chosen way, or recessed (main roof) / projecting (own roof). */
export function porchRoof(model: BuildingModel, room: Pick<DerivedRoom, 'polygon' | 'wallIds'> & { porchRoof?: PorchRoof; porchKind?: string }): PorchRoof {
  if (room.porchRoof) return room.porchRoof;
  // an open deck and a patio have no roof unless you give them one
  if (room.porchKind === 'deck' || room.porchKind === 'patio') return 'none';
  return houseShare(model, room) >= 0.4 ? 'main' : 'own';
}
