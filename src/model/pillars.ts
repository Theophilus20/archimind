/**
 * Free-standing pillars (columns, posts, piers). A pillar is a wall of kind 'column' as long as
 * it is thick, so it stands on the plan like any wall; its style says how it is drawn and built.
 */
import { nextId } from './edits';
import type { BuildingModel, ColumnStyle, EditOp, Vec2 } from './types';

export type { ColumnStyle };

export const PILLAR_TYPES: { style: ColumnStyle; label: string; icon: string; hint: string; size: number; material: string }[] = [
  { style: 'square', label: 'Square column', icon: 'crop_square', hint: 'Concrete, the usual structural column', size: 300, material: 'concrete' },
  { style: 'round', label: 'Round column', icon: 'circle', hint: 'Concrete or rendered, round', size: 300, material: 'concrete' },
  { style: 'classical', label: 'Classical column', icon: 'account_balance', hint: 'Round shaft with a base and a capital, for porticos', size: 350, material: 'plaster' },
  { style: 'brick', label: 'Brick pier', icon: 'grid_on', hint: 'Square brick pier with a stone cap', size: 450, material: 'brick' },
  { style: 'timber', label: 'Timber post', icon: 'park', hint: 'Square wooden post on a steel shoe, for porches and decks', size: 150, material: 'ash' },
  { style: 'steel', label: 'Steel column', icon: 'view_column', hint: 'H-section steel, for open plans and frames', size: 200, material: 'frame' },
];

export const pillarType = (s: ColumnStyle | undefined) => PILLAR_TYPES.find((p) => p.style === (s ?? 'square'))!;

/** The edit that stands a pillar of this style at a point, as tall as the tallest wall. */
export function pillarOp(model: BuildingModel, at: Vec2, style: ColumnStyle): EditOp {
  const t = pillarType(style);
  const height = model.walls.filter((w) => w.kind !== 'railing').reduce((h, w) => Math.max(h, w.height), model.defaults.wallHeight);
  return {
    op: 'addWall',
    wall: {
      id: nextId(model, 'W'),
      a: { x: Math.round(at.x - t.size / 2), y: Math.round(at.y) },
      b: { x: Math.round(at.x + t.size / 2), y: Math.round(at.y) },
      thickness: t.size,
      height,
      materialId: t.material,
      exterior: false,
      kind: 'column',
      columnStyle: style,
      prov: { position: 'confirmed', kind: 'confirmed' },
    },
  };
}
