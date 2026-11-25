/**
 * Typed commands for the plan, using short names common to drafting programs. Type one on
 * the command line and press Enter or Space (Enter on its own repeats the last command).
 */
import type { PlanTool } from './Plan2D';

export interface CommandContext {
  hasSelection: boolean;
  setTool: (t: PlanTool) => void;
  deleteSelected: () => void;
  duplicate: () => void;
  rotate: () => void;
  mirror: () => void;
  flipHinge: () => void;
  offset: (distance: number) => void;
  extend: () => void;
  corner: () => void;
  join: () => void;
  undo: () => void;
  redo: () => void;
  zoomAll: () => void;
  selectAll: () => void;
  help: () => void;
  toggleDims: () => string;
  /** A chain of walls is being drawn: C closes it, U takes back its last wall. */
  drawing: boolean;
  closeChain: () => void;
  undoSegment: () => void;
  /** Send a typed length to the wall being drawn. Returns false if no wall is being drawn. */
  length: (mm: number) => boolean;
  finish: () => void;
}

export interface Command {
  names: string[];
  label: string;
  /** What to do next, shown on the command line after the command starts. */
  prompt?: string;
  run: (ctx: CommandContext, arg?: number) => string | void;
  group: 'Draw' | 'Modify' | 'Select and view' | 'Measure';
}

export const COMMANDS: Command[] = [
  { names: ['WA', 'W', 'WALL', 'L', 'LINE', 'PL'], label: 'Wall', group: 'Draw', prompt: 'Click the start point, then each corner; walls join as you go. Type a length and Enter for an exact wall. C closes the shape, U takes back the last wall, Esc finishes.', run: (c) => c.setTool('wall') },
  { names: ['C', 'CLOSE'], label: 'Close the shape (while drawing walls)', group: 'Draw', run: (c) => (c.drawing ? c.closeChain() : 'Draw two or more walls first (WA), then C closes the shape.') },
  { names: ['DR', 'D', 'DOOR'], label: 'Door', group: 'Draw', prompt: 'Click a wall to place the door.', run: (c) => c.setTool('door') },
  { names: ['WN', 'N', 'WINDOW'], label: 'Window', group: 'Draw', prompt: 'Click a wall to place the window.', run: (c) => c.setTool('window') },
  { names: ['E', 'ERASE', 'DE', 'DELETE'], label: 'Erase', group: 'Modify', prompt: 'Click things, or drag a box over them, to erase. Esc to stop.', run: (c) => (c.hasSelection ? c.deleteSelected() : c.setTool('erase')) },
  { names: ['CO', 'CP', 'COPY'], label: 'Copy', group: 'Modify', run: (c) => (c.hasSelection ? c.duplicate() : 'Select something to copy first.') },
  { names: ['M', 'MV', 'MOVE'], label: 'Move', group: 'Modify', prompt: 'Drag a wall, door, window or furniture to move it.', run: (c) => c.setTool('select') },
  { names: ['RO', 'ROTATE'], label: 'Rotate 90°', group: 'Modify', run: (c) => (c.hasSelection ? c.rotate() : 'Select a wall or furniture to rotate.') },
  { names: ['MI', 'MM', 'MIRROR'], label: 'Mirror / flip swing', group: 'Modify', run: (c) => (c.hasSelection ? c.mirror() : 'Select a door or furniture to mirror.') },
  { names: ['H', 'FLIP'], label: 'Flip door hinge', group: 'Modify', run: (c) => c.flipHinge() },
  { names: ['O', 'OF', 'OFFSET'], label: 'Offset wall (O 500 = 500 mm)', group: 'Modify', run: (c, arg) => (c.hasSelection ? c.offset(arg && arg > 0 ? arg : 1000) : 'Select a wall to offset.') },
  { names: ['EX', 'EXTEND', 'TR', 'TRIM'], label: 'Extend / trim to the next wall', group: 'Modify', run: (c) => (c.hasSelection ? c.extend() : 'Select a wall to extend.') },
  { names: ['F', 'FILLET', 'CORNER'], label: 'Corner two walls', group: 'Modify', run: (c) => c.corner() },
  { names: ['J', 'JOIN'], label: 'Join two walls in a line', group: 'Modify', run: (c) => c.join() },
  { names: ['BR', 'BREAK', 'SL', 'SPLIT'], label: 'Split a wall', group: 'Modify', prompt: 'Click a wall where you want to cut it.', run: (c) => c.setTool('split') },
  { names: ['DIM', 'DLI', 'DAL', 'DIMENSION'], label: 'Add a dimension', group: 'Measure', prompt: 'Click the first point, then the second, then where the dimension line goes. Esc to stop.', run: (c) => c.setTool('dimension') },
  { names: ['DIMS'], label: 'Show or hide dimensions', group: 'Measure', run: (c) => c.toggleDims() },
  { names: ['DI', 'DIST', 'ME', 'MEASURE'], label: 'Measure', group: 'Measure', prompt: 'Click two points.', run: (c) => c.setTool('measure') },
  { names: ['U', 'UNDO'], label: 'Undo (while drawing walls: take back the last wall)', group: 'Modify', run: (c) => (c.drawing ? c.undoSegment() : c.undo()) },
  { names: ['REDO'], label: 'Redo', group: 'Modify', run: (c) => c.redo() },
  { names: ['Z', 'ZOOM', 'ZE', 'ZA', 'ZF'], label: 'Zoom to the whole plan', group: 'Select and view', run: (c) => c.zoomAll() },
  { names: ['SA', 'ALL', 'SELECTALL'], label: 'Select everything', group: 'Select and view', run: (c) => c.selectAll() },
  { names: ['V', 'SELECT'], label: 'Select', group: 'Select and view', run: (c) => c.setTool('select') },
  { names: ['?', 'HELP'], label: 'Shortcuts and commands', group: 'Select and view', run: (c) => c.help() },
];

export const SHORTCUTS: [string, string][] = [
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
  ['Ctrl+C / Ctrl+V / Ctrl+X', 'Copy / paste / cut'],
  ['Ctrl+D', 'Duplicate'],
  ['Ctrl+A', 'Select everything'],
  ['Delete', 'Delete the selection'],
  ['Arrow keys', 'Shift the selected furniture 50 mm (with Shift: 10 mm)'],
  ['Round handle', 'Drag it to turn the selected furniture (15° steps, Alt for any angle)'],
  ['Esc', 'Cancel, stop drawing, clear the selection'],
  ['Enter / Space', 'Run the typed command (Enter alone repeats the last one)'],
  ['F1', 'This help'],
  ['F3 / F7 / F8 / F9', 'OSNAP / GRID / ORTHO / SNAP on or off'],
  ['Shift (while drawing)', 'Override ORTHO for one point'],
  ['Drag empty space', 'Move around the plan (also middle or right drag)'],
  ['Shift+click', 'Add to the selection'],
  ['Shift+drag left to right', 'Window: select what is fully inside'],
  ['Shift+drag right to left', 'Crossing: select anything touched'],
  ['Erase tool + drag', 'Erase everything the box touches'],
  ['Mouse wheel', 'Zoom'],
];

/** Find a command by alias (case-insensitive). */
export function findCommand(name: string): Command | undefined {
  const n = name.trim().toUpperCase();
  return COMMANDS.find((c) => c.names.includes(n));
}

/** Suggestions for what has been typed so far (autocomplete). */
export function suggest(buffer: string): Command[] {
  const b = buffer.trim().toUpperCase();
  if (!b) return [];
  return COMMANDS.filter((c) => c.names.some((n) => n.startsWith(b)) || c.label.toUpperCase().startsWith(b)).slice(0, 5);
}

/**
 * Run typed input: an alias (optionally followed by a number, e.g. "O 500") or a bare number
 * (a length for the wall being drawn). Returns what to show on the command line.
 */
export function runInput(input: string, ctx: CommandContext): { message: string; ran?: Command } {
  const text = input.trim();
  if (!text) return { message: '' };
  const num = Number(text.replace(/mm$/i, ''));
  if (Number.isFinite(num) && /^[\d.]+(mm)?$/i.test(text)) {
    return ctx.length(Math.round(num)) ? { message: `Wall ${Math.round(num)} mm. Keep going, or Esc to stop.` } : { message: 'Start a wall first (WA), then type its length.' };
  }
  const [name, argText] = text.split(/\s+/);
  const cmd = findCommand(name);
  if (!cmd) {
    const s = suggest(name);
    return { message: s.length ? `Unknown command "${name.toUpperCase()}". Did you mean ${s.map((c) => c.names[0]).join(', ')}?` : `Unknown command "${name.toUpperCase()}". Press F1 for the list.` };
  }
  const arg = argText ? Number(argText) : undefined;
  const out = cmd.run(ctx, Number.isFinite(arg) ? arg : undefined);
  return { message: typeof out === 'string' ? out : `${cmd.label}${cmd.prompt ? `: ${cmd.prompt}` : ''}`, ran: cmd };
}
