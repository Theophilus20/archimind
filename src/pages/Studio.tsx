import { useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../state/store';
import { Plan2D, FURNITURE_SIZES, type PlanTool } from '../studio/Plan2D';
import { Viewer3D, viewerApi, type ViewerSettings } from '../studio/Viewer3D';
import { Inspector } from '../studio/Inspector';
import { PreviewBar } from '../studio/PreviewBar';
import { RoofDesigner } from '../studio/RoofDesigner';
import { usePins } from '../studio/usePins';
import { primaryIds } from '../model/edits';
import { elementKind } from '../model/elements';
import { Icon, Spinner } from '../ui/common';
import { navigate, useRoute } from '../ui/router';
import { useIsMobile } from '../ui/hooks';
import { uploadBlob } from '../firebase/storage';
import { track } from '../firebase/config';
import { proposeEdit } from '../ai/requests';
import { LocalModelUnavailable } from '../ai/hybrid';
import type { FurnitureKind } from '../model/types';
import { copyElements, cornerWalls, deleteElements, dimensionsOnLevel, duplicate, extendWall, flipHinge, joinWalls, mirror, offsetWall, pasteElements, rotate, type Clip } from '../model/edittools';
import { runInput } from '../studio/commands';
import { CommandBar, CommandHelp } from '../studio/CommandBar';
import { drawBus, useAids, useDrawing } from '../studio/aids';
import type { EditOp } from '../model/types';
import { DOOR_TYPES, doorLabel, type DoorType } from '../model/doortypes';
import { PORCH_KINDS, porchKindOf, type PorchKind } from '../model/porchtool';
import { PILLAR_TYPES, pillarType, type ColumnStyle } from '../model/pillars';

type Layout = '2d' | 'split' | '3d';

const FURNITURE: { kind: FurnitureKind; icon: string; label: string }[] = [
  { kind: 'bed', icon: 'bed', label: 'Bed' },
  { kind: 'wardrobe', icon: 'door_sliding', label: 'Wardrobe' },
  { kind: 'sideboard', icon: 'shelves', label: 'Sideboard or shelf' },
  { kind: 'desk', icon: 'desk', label: 'Desk' },
  { kind: 'chair', icon: 'chair_alt', label: 'Chair' },
  { kind: 'sofa', icon: 'weekend', label: 'Sofa' },
  { kind: 'tv', icon: 'tv', label: 'TV unit' },
  { kind: 'table', icon: 'table_restaurant', label: 'Dining table' },
  { kind: 'kitchen', icon: 'countertops', label: 'Kitchen run' },
  { kind: 'bath', icon: 'bathtub', label: 'Bath' },
  { kind: 'wc', icon: 'wc', label: 'Toilet' },
  { kind: 'basin', icon: 'wash', label: 'Basin' },
];

/** Stairs, placed like furniture. */
const STAIRS: { kind: FurnitureKind; icon: string; label: string; hint: string }[] = [
  { kind: 'stair', icon: 'stairs', label: 'Straight stair', hint: 'One flight' },
  { kind: 'stair-l', icon: 'turn_right', label: 'L-shaped stair', hint: 'Two flights at right angles, quarter landing' },
  { kind: 'stair-u', icon: 'u_turn_left', label: 'U-shaped stair', hint: 'Two flights side by side, half landing' },
  { kind: 'spiral', icon: 'cyclone', label: 'Spiral stair', hint: 'Round a central pole, small footprint' },
];

const AI_EXAMPLES = ['Make the kitchen 2 m² bigger', 'Add a desk to bedroom 2', 'Add a window to the hall', 'Widen D2 to 900 mm', 'Flip door D3'];

export function StudioPage() {
  const project = useStudio((s) => s.project);
  const preview = useStudio((s) => s.preview);
  const selection = useStudio((s) => s.selection);
  const edit = useStudio((s) => s.edit);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const past = useStudio((s) => s.past);
  const future = useStudio((s) => s.future);
  const toast = useStudio((s) => s.toast);
  const startPreview = useStudio((s) => s.startPreview);
  const model = preview?.model ?? project.model;

  const [layoutPref, setLayout] = useState<Layout>('split');
  const isMobile = useIsMobile();
  const [mobilePane, setMobilePane] = useState<'plan' | '3d' | 'inspect'>('3d');
  const layout: Layout = isMobile ? 'split' : layoutPref;
  const [tool, setTool] = useState<PlanTool>('select');
  // "Sketch a plan" opens the studio on the plan with the Room tool ready.
  const { params: routeParams } = useRoute();
  const projectId = useStudio((s) => s.project.id);
  const chain = useDrawing((s) => s.chain);
  const drawFor = useRef<string | null>(null);
  useEffect(() => {
    const draw = routeParams.get('draw');
    if (draw !== 'wall' || (drawFor.current !== null && drawFor.current !== projectId)) return setTool('select');
    drawFor.current = projectId;
    setLayout('2d');
    setMobilePane('plan');
    setTool(draw);
    // Another project opened: start it with the plain select tool.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  const [furnitureKind, setFurnitureKind] = useState<FurnitureKind>('bed');
  /** The kind of door the door tool places, and its menu. */
  const [doorType, setDoorType] = useState<DoorType>('hinged');
  const [doorMenu, setDoorMenu] = useState(false);
  /** The kind of porch the porch tool adds, and the porch and stairs menu. */
  const [porchKind, setPorchKind] = useState<PorchKind>('porch');
  const [outdoorMenu, setOutdoorMenu] = useState(false);
  const [pillarStyle, setPillarStyle] = useState<ColumnStyle>('square');
  const [library, setLibrary] = useState(false);
  const [roofPanel, setRoofPanel] = useState(false);
  const [underlay, setUnderlay] = useState(true);
  // Show the roof whenever the building has one (generated, or designed in the Roof panel).
  const hasRoof = (m: typeof model) => !!m.spec || (!!m.roof && m.roof.kind !== 'none');
  const [settings, setSettings] = useState<ViewerSettings>(() => ({ mode: 'orbit', hour: 15, section: null, roof: hasRoof(useStudio.getState().project.model), furniture: true, doorsOpen: true, people: false }));
  const roofProject = useStudio((s) => s.project.id);
  const roofKind = useStudio((s) => s.project.model.roof?.kind ?? 'none');
  useEffect(() => {
    setSettings((st) => ({ ...st, roof: hasRoof(useStudio.getState().project.model) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roofProject, roofKind]);
  const [ask, setAsk] = useState('');
  const [asking, setAsking] = useState(false);
  const askRef = useRef<HTMLInputElement>(null);
  const allPins = usePins();
  // The "!" markers for findings and comments can be hidden (remembered in this browser).
  const [showMarkers, setShowMarkers] = useState(() => {
    try {
      return localStorage.getItem('archimind.markers') !== 'off';
    } catch {
      return true;
    }
  });
  const toggleMarkers = () =>
    setShowMarkers((v) => {
      try {
        localStorage.setItem('archimind.markers', v ? 'off' : 'on');
      } catch {
        /* private mode */
      }
      return !v;
    });
  const pins = showMarkers ? allPins : [];

  const previewIds = useMemo(() => new Set(preview ? preview.proposal.edits.flatMap(primaryIds) : []), [preview]);
  const set = (p: Partial<ViewerSettings>) => setSettings((s) => ({ ...s, ...p }));

  /** Run an edit command on the selected element; explain plainly when it can't be done. */
  const runEdit = (fn: (m: typeof project.model, id: string) => EditOp[] | string, label: string) => {
    const id = useStudio.getState().selection[0];
    if (!id || preview) return;
    const ops = fn(useStudio.getState().project.model, id);
    if (typeof ops === 'string') return toast(ops, 'error');
    const r = edit(ops, `${label} ${id}`);
    if (!r.ok) toast(r.errors[0] ?? 'That change is not possible here.', 'error');
  };

  // --- typed commands (common shortcuts) -------------------------------------------------
  const [cmdBuffer, setCmdBuffer] = useState('');
  const [multiSelect, setMultiSelect] = useState(false);
  const [cmdMessage, setCmdMessage] = useState('Type a command (WA wall, E erase, CO copy…) or press F1 for help.');
  const [helpOpen, setHelpOpen] = useState(false);
  const lastCmd = useRef('');
  const clip = useRef<{ data: Clip; pastes: number } | null>(null);
  const selectAction = useStudio((s) => s.select);
  const focusOnAction = useStudio((s) => s.focusOn);
  const walls2 = () => useStudio.getState().selection.filter((id) => elementKind(useStudio.getState().project.model, id) === 'wall');
  const deleteSelected = () => {
    const st = useStudio.getState();
    if (!st.selection.length || preview) return;
    const ops = deleteElements(st.project.model, st.selection);
    if (typeof ops === 'string') return toast(ops, 'error');
    if (edit(ops, `Delete ${st.selection.length} item${st.selection.length === 1 ? '' : 's'}`).ok) selectAction([]);
  };
  const copySelected = () => {
    const st = useStudio.getState();
    if (!st.selection.length) return toast('Select something to copy.', 'info');
    clip.current = { data: copyElements(st.project.model, st.selection), pastes: 0 };
    const n = clip.current.data.walls.length + clip.current.data.furniture.length;
    toast(n ? `Copied ${n} item${n === 1 ? '' : 's'}. Ctrl+V to paste.` : 'Walls and furniture can be copied (doors and windows come with their walls).', n ? 'success' : 'info');
  };
  const paste = () => {
    if (!clip.current || preview) return;
    clip.current.pastes += 1;
    const by = 1000 * clip.current.pastes;
    const { ops, ids } = pasteElements(useStudio.getState().project.model, clip.current.data, { x: by, y: by });
    if (ops.length && edit(ops, 'Paste').ok) selectAction(ids);
  };
  const selectAll = () => {
    const m = useStudio.getState().project.model;
    const dims = useAids.getState().dims ? dimensionsOnLevel(m).map((d) => d.id) : [];
    selectAction([...m.walls.map((w) => w.id), ...m.openings.map((o) => o.id), ...m.furniture.map((f) => f.id), ...dims]);
  };
  const cmdCtx = () => ({
    hasSelection: useStudio.getState().selection.length > 0,
    setTool: (t: PlanTool) => setTool(t),
    deleteSelected,
    duplicate: () => (useStudio.getState().selection.length > 1 ? (copySelected(), paste()) : runEdit(duplicate, 'Duplicate')),
    rotate: () => runEdit(rotate, 'Rotate'),
    mirror: () => runEdit(mirror, 'Mirror'),
    flipHinge: () => runEdit(flipHinge, 'Flip door hinge'),
    offset: (d: number) => runEdit((m, i) => offsetWall(m, i, d), `Offset ${d} mm`),
    extend: () => (walls2().length === 2 ? corner() : runEdit(extendWall, 'Extend wall')),
    corner: () => corner(),
    join: () => {
      const [x, y] = walls2();
      if (!x || !y) return toast('Select two walls (Shift+click) to join.', 'info');
      const ops = joinWalls(useStudio.getState().project.model, x, y);
      if (typeof ops === 'string') return toast(ops, 'error');
      edit(ops, `Join walls ${x} and ${y}`);
    },
    undo,
    redo,
    zoomAll: () => focusOnAction(useStudio.getState().project.model.walls.map((w) => w.id)),
    selectAll,
    help: () => setHelpOpen(true),
    toggleDims: () => {
      useAids.getState().toggle('dims');
      return `Dimensions ${useAids.getState().dims ? 'shown' : 'hidden'}.`;
    },
    length: (mm: number) => {
      if (tool !== 'wall') return false;
      drawBus.send({ type: 'length', value: mm });
      return true;
    },
    finish: () => drawBus.send({ type: 'finish' }),
    drawing: useDrawing.getState().chain !== null,
    closeChain: () => drawBus.send({ type: 'close' }),
    undoSegment: () => drawBus.send({ type: 'undoSegment' }),
  });
  function corner() {
    const [x, y] = walls2();
    if (!x || !y) return toast('Select two walls (Shift+click) to join them in a corner.', 'info');
    const ops = cornerWalls(useStudio.getState().project.model, x, y);
    if (typeof ops === 'string') return toast(ops, 'error');
    edit(ops, `Corner walls ${x} and ${y}`);
  }
  const execute = (input: string) => {
    const text = input.trim() || lastCmd.current;
    if (!text) return;
    const out = runInput(text, cmdCtx());
    if (out.ran) lastCmd.current = out.ran.names[0];
    setCmdMessage(out.message);
    setCmdBuffer('');
  };

  // Keyboard: Ctrl shortcuts and F-keys act at once; letters build a command for Enter/Space (as in most drafting programs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (settings.mode === 'walk') return;
      if (document.querySelector('.scrim')) return; // a dialog is open
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl) {
        const act: Record<string, () => void> = {
          z: () => (e.shiftKey ? redo() : undo()),
          y: redo,
          a: selectAll,
          c: copySelected,
          v: paste,
          x: () => (copySelected(), deleteSelected()),
          d: () => cmdCtx().duplicate(),
          s: () => toast('Your work saves automatically.', 'info'),
        };
        if (act[key]) {
          e.preventDefault();
          act[key]();
        }
        return;
      }
      // Arrow keys shift the selected furniture: 50 mm a press, 10 mm with Shift.
      const arrow = ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[e.key];
      if (arrow && !preview) {
        const items = project.model.furniture.filter((f) => selection.includes(f.id));
        if (!items.length) return;
        e.preventDefault();
        const n = e.shiftKey ? 10 : 50;
        edit(items.map((f) => ({ op: 'moveFurniture' as const, furnitureId: f.id, x: f.x + arrow[0] * n, y: f.y + arrow[1] * n })), `Shift ${items.map((f) => f.id).join(', ')}`);
        return;
      }
      if (e.key === 'F1') return e.preventDefault(), setHelpOpen(true);
      const aid = ({ F3: 'osnap', F7: 'grid', F8: 'ortho', F9: 'snap' } as const)[e.key as 'F3'];
      if (aid) {
        e.preventDefault();
        useAids.getState().toggle(aid);
        setCmdMessage(`${aid.toUpperCase()} ${useAids.getState()[aid] ? 'on' : 'off'}`);
        return;
      }
      if (e.key === 'Escape') {
        if (cmdBuffer) return setCmdBuffer('');
        // First Esc ends the chain of walls and keeps them; the next one puts the tool away.
        if (useDrawing.getState().chain !== null) {
          drawBus.send({ type: 'finish' });
          setCmdMessage('Walls kept. Click to start more walls, or press Esc again to stop.');
          return;
        }
        drawBus.send({ type: 'finish' });
        if (tool !== 'select') setTool('select');
        else selectAction([]);
        setLibrary(false);
        setCmdMessage('Cancelled.');
        return;
      }
      if ((e.key === 'Delete' || (e.key === 'Backspace' && !cmdBuffer)) && !preview) {
        e.preventDefault();
        return deleteSelected();
      }
      if (e.key === 'Backspace') return e.preventDefault(), setCmdBuffer((b) => b.slice(0, -1));
      if (e.key === 'Enter' || (e.key === ' ' && cmdBuffer)) {
        e.preventDefault();
        return execute(cmdBuffer);
      }
      if (e.key === '/') {
        e.preventDefault();
        askRef.current?.focus();
        return;
      }
      if (/^[a-zA-Z0-9.?]$/.test(e.key) && !e.altKey) {
        e.preventDefault();
        setCmdBuffer((b) => (b + e.key).toUpperCase().slice(0, 16));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const screenshot = () => {
    const url = viewerApi.capture?.();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/\s+/g, '-')}.jpg`;
    a.click();
  };
  const exportGlb = async () => {
    try {
      const blob = await viewerApi.exportGLB!();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${project.name.replace(/\s+/g, '-')}.glb`;
      a.click();
      track('model_exported', { format: 'glb', revision: model.revision });
      const url = await uploadBlob(`projects/${project.id}/exports/rev-${model.revision}.glb`, blob, { revision: String(model.revision) }).catch(() => null);
      if (url) {
        await navigator.clipboard?.writeText(url).catch(() => undefined);
        toast('3D model downloaded. A share link was copied to your clipboard.', 'success');
      } else toast('3D model downloaded', 'success');
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, 'error');
    }
  };

  const askAI = async (text = ask) => {
    const q = text.trim();
    if (!q || asking) return;
    setAsking(true);
    try {
      const r = await proposeEdit(project.model, project.brief, project.findings, q);
      if (!r.data) {
        toast("I couldn't turn that into a safe change. Try naming a room or element, for example: make the kitchen bigger.", 'error');
        return;
      }
      if (startPreview(r.data)) {
        setAsk('');
        toast(`${r.data.label}. Check the preview, then accept or discard it.`, 'info');
      }
    } catch (e) {
      toast(e instanceof LocalModelUnavailable ? e.message : (e as Error).message, 'error');
    } finally {
      setAsking(false);
    }
  };

  const show2D = layout !== '3d';
  const show3D = layout !== '2d';
  // On a phone the toolbar shows the tools for the tab you're on, so none hide off the edge.
  const tools2D = show2D && (!isMobile || mobilePane === 'plan');
  const tools3D = show3D && (!isMobile || mobilePane === '3d');
  const sep = <span className="divider" style={{ width: 1, height: 24, margin: '0 4px' }} />;

  return (
    <div className={`studio ${layout === 'split' ? '' : 'single'}`} data-mobile={mobilePane}>
      <div className="studio-toolbar">
        <div className="seg hide-mobile" role="group" aria-label="Layout">
          <button className={layout === '2d' ? 'on' : ''} onClick={() => setLayout('2d')}>
            <Icon name="grid_on" /> Plan
          </button>
          <button className={layout === 'split' ? 'on' : ''} onClick={() => setLayout('split')}>
            <Icon name="vertical_split" /> Split
          </button>
          <button className={layout === '3d' ? 'on' : ''} onClick={() => setLayout('3d')}>
            <Icon name="view_in_ar" /> 3D
          </button>
        </div>
        {tools2D && (
          <>
            {sep}
            {(
              [
                ['select', 'arrow_selector_tool', 'Select and move (V)'],
                ['wall', 'polyline', 'Draw walls (WA)'],
                ['door', 'door_front', 'Add a door (DR)'],
                ['window', 'window', 'Add a window (WN)'],
                ['measure', 'straighten', 'Measure (DI)'],
                ['split', 'content_cut', 'Split a wall: click where to cut it (SL)'],
                ['erase', 'ink_eraser', 'Erase: click or drag a box over things to delete them (E)'],
                ['dimension', 'width', 'Add a dimension: click two points, then where the line goes (DIM)'],
              ] as [PlanTool, string, string][]
            ).map(([t, icon, label]) =>
              t === 'door' ? (
                // Doors: the tool places the kind chosen from its menu (hinged, double, sliding,
                // pocket, folding, or an open passage)
                <div key={t} style={{ position: 'relative', display: 'flex' }}>
                  <button
                    className={`icon-btn ${tool === 'door' ? 'on' : ''}`}
                    title={`Add a ${doorLabel(doorType).toLowerCase()} (DR)`}
                    aria-label={`Add a ${doorLabel(doorType).toLowerCase()}`}
                    onClick={() => setTool('door')}
                    disabled={!!preview}
                  >
                    <Icon name={DOOR_TYPES.find((d) => d.type === doorType)!.icon} />
                  </button>
                  <button className="icon-btn door-caret" title="Choose the kind of door" aria-label="Choose the kind of door" aria-expanded={doorMenu} onClick={() => setDoorMenu((v) => !v)} disabled={!!preview} style={{ width: 18, marginLeft: -6 }}>
                    <Icon name="arrow_drop_down" />
                  </button>
                  {doorMenu && (
                    <div className="menu" style={{ top: 38, left: 0, minWidth: 260 }}>
                      <div className="menu-label">Pick a kind, then click a wall to put it there</div>
                      {DOOR_TYPES.map((d) => (
                        <button
                          key={d.type}
                          className={`menu-item ${doorType === d.type ? 'on' : ''}`}
                          onClick={() => {
                            setDoorType(d.type);
                            setTool('door');
                            setDoorMenu(false);
                          }}
                        >
                          <Icon name={d.icon} />
                          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                            <span>{d.label}</span>
                            <small className="muted">{d.hint}</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <button key={t} className={`icon-btn ${tool === t ? 'on' : ''}`} title={label} aria-label={label} onClick={() => setTool(t)} disabled={!!preview}>
                  <Icon name={icon} />
                </button>
              ),
            )}
            {/* Touch screens have no Shift key: this makes each tap add to the selection */}
            <button className={`icon-btn touch-only ${multiSelect ? 'on' : ''}`} title="Select several (each tap adds)" aria-label="Select several" aria-pressed={multiSelect} onClick={() => setMultiSelect((v) => !v)}>
              <Icon name="select_all" />
            </button>
            {/* Delete the selected wall, door, window or furniture (also the Delete key) */}
            <button
              className="icon-btn"
              title="Delete the selection (Delete)"
              aria-label="Delete selected"
              disabled={!!preview || !selection.some((id) => ['wall', 'opening', 'furniture', 'dimension'].includes(elementKind(project.model, id) ?? ''))}
              onClick={deleteSelected}
            >
              <Icon name="delete" />
            </button>
            {(() => {
              const id = selection[0];
              const kind = id && !preview ? elementKind(project.model, id) : null;
              const isDoor = kind === 'opening' && project.model.openings.find((o) => o.id === id)?.kind === 'door';
              const acts: [string, string, () => void][] = [];
              const twoWalls = selection.filter((x) => elementKind(project.model, x) === 'wall').length === 2;
              if (twoWalls && !preview) {
                acts.push(['turn_sharp_right', 'Corner: make the two walls meet (F)', () => corner()]);
                acts.push(['join', 'Join two walls in a line (J)', () => cmdCtx().join()]);
              }
              if (kind === 'wall' || kind === 'opening' || kind === 'furniture') acts.push(['content_copy', 'Duplicate (Ctrl+D)', () => runEdit(duplicate, 'Duplicate')]);
              if (kind === 'wall') {
                acts.push(['align_horizontal_center', 'Offset: parallel copy 1 m away (O, or type O 500)', () => runEdit((m, i) => offsetWall(m, i, 1000), 'Offset wall')]);
                acts.push(['rotate_90_degrees_cw', 'Rotate 90° (RO)', () => runEdit(rotate, 'Rotate wall')]);
                acts.push(['open_in_full', 'Extend or trim to meet the next wall (EX)', () => runEdit(extendWall, 'Extend wall')]);
              }
              if (kind === 'furniture') {
                acts.push(['rotate_90_degrees_cw', 'Rotate 90° (RO)', () => runEdit(rotate, 'Rotate')]);
                acts.push(['flip', 'Mirror: face the other way (MI)', () => runEdit(mirror, 'Mirror')]);
              }
              if (isDoor) {
                acts.push(['flip', 'Flip swing to the other side (MI)', () => runEdit(mirror, 'Flip door swing')]);
                acts.push(['swap_horiz', 'Flip hinge side (H)', () => runEdit(flipHinge, 'Flip door hinge')]);
              }
              return acts.map(([icon, label, fn]) => (
                <button key={label} className="icon-btn" title={label} aria-label={label} onClick={fn}>
                  <Icon name={icon} />
                </button>
              ));
            })()}
            <div style={{ position: 'relative' }}>
              <button
                className={`btn btn-sm ${tool === 'porch' || tool === 'pillar' || outdoorMenu || (tool === 'furniture' && STAIRS.some((x) => x.kind === furnitureKind)) ? 'btn-tonal' : 'btn-text'}`}
                onClick={() => (setOutdoorMenu((v) => !v), setLibrary(false))}
                disabled={!!preview}
                aria-expanded={outdoorMenu}
                title="Add a porch, veranda, deck, patio or balcony, a stair, or a pillar"
              >
                <Icon name="deck" /> <span className="label-wide">Porch, stairs, pillars</span>
                <Icon name="arrow_drop_down" />
              </button>
              {outdoorMenu && (
                <div className="menu" style={{ top: 38, left: 0, minWidth: 300, maxHeight: '70vh', overflowY: 'auto' }}>
                  <div className="menu-label">Porches and outdoor spaces: pick one, then click just outside a wall</div>
                  {PORCH_KINDS.map((pk) => (
                    <button
                      key={pk.kind}
                      className={`menu-item ${tool === 'porch' && porchKind === pk.kind ? 'on' : ''}`}
                      onClick={() => {
                        setPorchKind(pk.kind);
                        setTool('porch');
                        setOutdoorMenu(false);
                      }}
                    >
                      <Icon name={pk.icon} />
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                        <span>{pk.label}</span>
                        <small className="muted">{pk.hint}</small>
                      </span>
                    </button>
                  ))}
                  <div className="menu-label">Stairs: pick one, then click the plan to place it</div>
                  {STAIRS.map((st) => (
                    <button
                      key={st.kind}
                      className={`menu-item ${tool === 'furniture' && furnitureKind === st.kind ? 'on' : ''}`}
                      onClick={() => {
                        setFurnitureKind(st.kind);
                        setTool('furniture');
                        setOutdoorMenu(false);
                      }}
                    >
                      <Icon name={st.icon} />
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                        <span>{st.label}</span>
                        <small className="muted">
                          {st.hint} · {(FURNITURE_SIZES[st.kind][0] / 1000).toFixed(1)} × {(FURNITURE_SIZES[st.kind][1] / 1000).toFixed(1)} m
                        </small>
                      </span>
                    </button>
                  ))}
                  <div className="menu-label">Pillars: pick one, then click where it stands</div>
                  {PILLAR_TYPES.map((pt) => (
                    <button
                      key={pt.style}
                      className={`menu-item ${tool === 'pillar' && pillarStyle === pt.style ? 'on' : ''}`}
                      onClick={() => {
                        setPillarStyle(pt.style);
                        setTool('pillar');
                        setOutdoorMenu(false);
                      }}
                    >
                      <Icon name={pt.icon} />
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                        <span>{pt.label}</span>
                        <small className="muted">
                          {pt.hint} · {pt.size} mm
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ position: 'relative' }}>
              <button className={`btn btn-sm ${tool === 'furniture' || library ? 'btn-tonal' : 'btn-text'}`} onClick={() => setLibrary((v) => !v)} disabled={!!preview} aria-expanded={library}>
                <Icon name="chair" /> <span className="label-wide">Furniture</span>
                <Icon name="arrow_drop_down" />
              </button>
              {library && (
                <div className="menu furniture-menu" style={{ top: 38, left: 0 }}>
                  <div className="menu-label">Click an item, then click the plan to place it</div>
                  <div className="furniture-grid">
                    {FURNITURE.map((f) => (
                      <button
                        key={f.kind}
                        className={tool === 'furniture' && furnitureKind === f.kind ? 'on' : ''}
                        onClick={() => {
                          setFurnitureKind(f.kind);
                          setTool('furniture');
                          setLibrary(false);
                        }}
                      >
                        <Icon name={f.icon} />
                        <span>{f.label}</span>
                        <small>
                          {(FURNITURE_SIZES[f.kind][0] / 1000).toFixed(1)} × {(FURNITURE_SIZES[f.kind][1] / 1000).toFixed(1)} m
                        </small>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button className={`icon-btn ${underlay ? 'on' : ''}`} title="Show the uploaded drawing underneath" aria-label="Show uploaded drawing" onClick={() => setUnderlay((v) => !v)} disabled={!model.source}>
              <Icon name="image" />
            </button>
          </>
        )}
        {sep}
        <button className="icon-btn" title="Undo (Ctrl+Z)" aria-label="Undo" onClick={undo} disabled={!past.length || !!preview}>
          <Icon name="undo" />
        </button>
        <button className="icon-btn" title="Redo (Ctrl+Y)" aria-label="Redo" onClick={redo} disabled={!future.length || !!preview}>
          <Icon name="redo" />
        </button>
        {tools3D && (
          <>
            {sep}
            <div className="seg">
              <button className={settings.mode === 'orbit' ? 'on' : ''} onClick={() => set({ mode: 'orbit' })}>
                <Icon name="3d_rotation" /> Orbit
              </button>
              <button className={settings.mode === 'walk' ? 'on' : ''} onClick={() => (set({ mode: 'walk' }), isMobile && setMobilePane('3d'))}>
                <Icon name="directions_walk" /> Walk
              </button>
            </div>
            <label className="row small muted" title="Sun position (time of day)" style={{ gap: 6 }}>
              <Icon name={settings.hour < 8 || settings.hour > 17 ? 'wb_twilight' : 'light_mode'} style={{ color: 'var(--fb-amber)' }} />
              <input type="range" min={6.5} max={19.5} step={0.25} value={settings.hour} onChange={(e) => set({ hour: Number(e.target.value) })} style={{ width: 80 }} aria-label="Time of day" />
              <span style={{ width: 38 }}>
                {Math.floor(settings.hour)}:{String(Math.round((settings.hour % 1) * 60)).padStart(2, '0')}
              </span>
            </label>
            <button className="icon-btn" title="Reset view" aria-label="Reset view" onClick={() => viewerApi.home?.()} disabled={settings.mode === 'walk'}>
              <Icon name="center_focus_strong" />
            </button>
            <button className={`icon-btn ${settings.section !== null ? 'on' : ''}`} title="Section cut" aria-label="Section cut" onClick={() => set({ section: settings.section === null ? 1.4 : null })}>
              <Icon name="content_cut" />
            </button>
            {settings.section !== null && <input type="range" min={0.3} max={3.2} step={0.05} value={settings.section} onChange={(e) => set({ section: Number(e.target.value) })} style={{ width: 70 }} aria-label="Section height" />}
            <button className={`btn btn-sm ${roofPanel ? 'btn-tonal' : 'btn-text'}`} title="Design the roof" onClick={() => (setRoofPanel((v) => !v), isMobile && setMobilePane('3d'))}>
              <Icon name="roofing" /> <span className="label-wide">Roof</span>
            </button>
            <button className={`icon-btn ${settings.people ? 'on' : ''}`} title="People walking through the house" aria-label="People" onClick={() => set({ people: !settings.people })}>
              <Icon name="groups" />
            </button>
            <button className={`icon-btn ${settings.furniture ? 'on' : ''}`} title="Show furniture" aria-label="Show furniture" onClick={() => set({ furniture: !settings.furniture })}>
              <Icon name="chair_alt" />
            </button>
            <button className={`icon-btn ${settings.doorsOpen ? 'on' : ''}`} title="Doors open" aria-label="Doors open" onClick={() => set({ doorsOpen: !settings.doorsOpen })}>
              <Icon name="door_open" />
            </button>
          </>
        )}
        <button className={`icon-btn ${showMarkers ? 'on' : ''}`} onClick={toggleMarkers} title={showMarkers ? 'Hide the markers for findings and comments' : 'Show the markers for findings and comments'} aria-label={showMarkers ? 'Hide markers' : 'Show markers'} aria-pressed={showMarkers}>
          <Icon name={showMarkers ? 'location_on' : 'location_off'} />
        </button>
        <div className="grow" />
        {tools3D && (
          <>
            <button className="btn btn-text btn-sm" onClick={screenshot} title="Save a picture of the 3D view">
              <Icon name="photo_camera" /> <span className="label-wide">Picture</span>
            </button>
            <button className="btn btn-text btn-sm" onClick={exportGlb} title="Download the 3D model (GLB)">
              <Icon name="deployed_code" /> <span className="label-wide">3D file</span>
            </button>
          </>
        )}
        <button className="btn btn-tonal btn-sm" onClick={() => navigate('crit', selection.length ? { anchor: selection[0] } : undefined)}>
          <Icon name="forum" /> <span className="label-wide">Crit room</span>
        </button>
      </div>

      <form
        className="ai-bar"
        onSubmit={(e) => {
          e.preventDefault();
          askAI();
        }}
      >
        <Icon name="auto_awesome" style={{ color: 'var(--blue)' }} />
        <input ref={askRef} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask AI to change the plan, for example: make the kitchen 2 m² bigger" aria-label="Ask AI to change the plan" disabled={!!preview} list="ai-examples" />
        <datalist id="ai-examples">
          {AI_EXAMPLES.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <button className="btn btn-primary btn-sm" type="submit" disabled={!ask.trim() || asking || !!preview}>
          {asking ? <Spinner size={16} /> : <Icon name="send" />} <span className="label-wide">Suggest</span>
        </button>
      </form>

      <div className="mobile-tabs" role="tablist">
        {(
          [
            ['plan', 'grid_on', 'Plan'],
            ['3d', 'view_in_ar', '3D'],
            ['inspect', 'info', selection.length ? `Details · ${selection[0]}` : 'Details'],
          ] as const
        ).map(([k, icon, label]) => (
          <button key={k} role="tab" aria-selected={mobilePane === k} className={mobilePane === k ? 'on' : ''} onClick={() => setMobilePane(k)}>
            <Icon name={icon} /> {label}
          </button>
        ))}
      </div>
      {show2D && (
        <div className="pane plan">
          <div className="pane-label">
            <span className="chip">
              <Icon name="grid_on" />
              {tool === 'measure' ? 'Click two points to measure' : tool === 'furniture' ? `Click to place a ${(FURNITURE.find((f) => f.kind === furnitureKind) ?? STAIRS.find((f) => f.kind === furnitureKind))?.label.toLowerCase()}` : tool === 'porch' ? `Click just outside an outside wall to add a ${porchKindOf(porchKind).label.toLowerCase()}` : tool === 'pillar' ? `Click where the ${pillarType(pillarStyle).label.toLowerCase()} stands` : tool === 'wall' ? 'Wall: click each corner; walls join as you go' : tool === 'split' ? 'Click a wall where you want to cut it' : tool === 'erase' ? 'Erase: click things or drag a box over them' : tool === 'dimension' ? 'Dimension: first point, second point, then where the line goes' : 'Plan: drag walls, doors and furniture'}
            </span>
            {tool !== 'select' && (
              <button className="chip clickable" onClick={() => setTool('select')}>
                <Icon name="close" /> Done
              </button>
            )}
          </div>
          {tool === 'wall' && chain !== null && (
            <div className="draw-bar" role="toolbar" aria-label="Drawing walls">
              <span className="small">{chain === 0 ? 'Click the next corner' : `${chain} wall${chain === 1 ? '' : 's'} drawn. Click the next corner`}</span>
              <button className="btn btn-sm btn-text" onClick={() => drawBus.send({ type: 'undoSegment' })} disabled={chain === 0} title="Take back the last wall (U)">
                <Icon name="undo" /> Undo<span className="more"> last</span>
              </button>
              <button className="btn btn-sm btn-text" onClick={() => drawBus.send({ type: 'close' })} disabled={chain < 2} title="Draw a wall back to the first point and stop (C)">
                <Icon name="hexagon" /> Close<span className="more"> shape</span>
              </button>
              <button className="btn btn-sm btn-tonal" onClick={() => drawBus.send({ type: 'finish' })} title="Stop here and keep the walls (Esc)">
                <Icon name="check" /> Finish
              </button>
              <button className="btn btn-sm btn-text" style={{ color: 'var(--red)' }} onClick={() => drawBus.send({ type: 'cancel' })} title="Remove the walls of this chain and stop">
                <Icon name="close" /> Cancel
              </button>
            </div>
          )}
          {model.walls.length === 0 && !preview && chain === null && (
            <div className="plan-empty" role="note">
              <b>Empty plan</b>
              <span>With the Wall tool, click where the outside wall starts, then click each corner. Walls join as you go. Click the first point again, or press C, to close the shape. Then add inside walls, doors and windows.</span>
              <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
                <button className={`btn btn-sm ${tool === 'wall' ? 'btn-primary' : 'btn-tonal'}`} onClick={() => setTool('wall')}>
                  <Icon name="polyline" /> Wall
                </button>
                <button className="btn btn-sm btn-text" onClick={() => navigate('import')}>
                  <Icon name="upload_file" /> Import a drawing
                </button>
              </div>
            </div>
          )}
          <Plan2D
            model={model}
            ghost={preview ? project.model : null}
            previewIds={previewIds}
            pins={pins}
            editable={!preview}
            showUnderlay={underlay}
            tool={tool}
            furnitureKind={furnitureKind}
            doorType={doorType}
            porchKind={porchKind}
            pillarStyle={pillarStyle}
            onToolUsed={() => tool !== 'furniture' && tool !== 'erase' && tool !== 'dimension' && setTool('select')}
            multiSelect={multiSelect}
            showRoof={settings.roof || roofPanel}
          />
          <CommandBar buffer={cmdBuffer} message={cmdMessage} onPick={(alias) => execute(alias)} onHelp={() => setHelpOpen(true)} />
        </div>
      )}
      {show3D && (
        <div className="pane">
          <div className="pane-label">
            <span className="chip">
              <Icon name="view_in_ar" /> 3D view
            </span>
          </div>
          <Viewer3D model={model} settings={settings} pins={pins} previewIds={previewIds} onExitWalk={() => set({ mode: 'orbit' })} />
          {roofPanel && settings.mode === 'orbit' && <RoofDesigner visible={settings.roof} onVisible={(v) => set({ roof: v })} onClose={() => setRoofPanel(false)} />}
        </div>
      )}
      <Inspector />
      <PreviewBar />
      {helpOpen && <CommandHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
