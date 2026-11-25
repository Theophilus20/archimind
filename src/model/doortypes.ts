/**
 * The kinds of door you can add or change a door to, in the studio and when checking an import.
 * A door is an opening of kind 'door' with a style; an open passage is an opening with no door.
 */
import type { Opening } from './types';

export type DoorType = 'hinged' | 'double' | 'sliding' | 'pocket' | 'folding' | 'opening';

export const DOOR_TYPES: { type: DoorType; label: string; icon: string; width: number; hint: string }[] = [
  { type: 'hinged', label: 'Hinged door', icon: 'door_front', width: 850, hint: 'One leaf on hinges, swinging into the room' },
  { type: 'double', label: 'Double door', icon: 'door_open', width: 1600, hint: 'Two leaves meeting in the middle' },
  { type: 'sliding', label: 'Sliding door', icon: 'door_sliding', width: 1800, hint: 'Two glass panels, one slides behind the other (patio, porch)' },
  { type: 'pocket', label: 'Pocket door', icon: 'sensor_door', width: 850, hint: 'One leaf that slides into the wall' },
  { type: 'folding', label: 'Folding door', icon: 'view_week', width: 1600, hint: 'Leaves that fold back to each side (wardrobes, utility rooms)' },
  { type: 'opening', label: 'Open passage', icon: 'crop_free', width: 1200, hint: 'A gap in the wall with no door, like an open kitchen' },
];

export const doorLabel = (t: DoorType | 'window') => (t === 'window' ? 'Window' : DOOR_TYPES.find((d) => d.type === t)!.label);

/** What an opening is, as one of the door types (or a window). */
export const doorTypeOf = (o: Pick<Opening, 'kind' | 'style'>): DoorType | 'window' => (o.kind === 'window' ? 'window' : o.kind === 'opening' ? 'opening' : (o.style ?? 'hinged'));

/** The kind and style for a door type (or a window). */
export function doorPatch(t: DoorType | 'window'): { kind: Opening['kind']; style: Opening['style'] } {
  if (t === 'window') return { kind: 'window', style: undefined };
  if (t === 'opening') return { kind: 'opening', style: undefined };
  return { kind: 'door', style: t === 'hinged' ? undefined : t };
}
