import { useState } from 'react';
import { allRooms } from '../model/levels';
import { useStudio } from '../state/store';
import { derive } from '../model/derive';
import { validateModel } from '../model/validate';
import { wallLength } from '../model/geometry';
import { elementKind } from '../model/elements';
import { floorMaterials, wallMaterials } from '../model/materials';
import { ROOM_TYPES, type BuildingModel, type EditOp, type Furniture, type FurnitureKind, type Id, type Provenance } from '../model/types';
import { backToWall } from '../detect/furniture';
import { DOOR_TYPES, doorLabel, doorPatch, doorTypeOf, type DoorType } from '../model/doortypes';
import { PORCH_KINDS, porchKindOf, porchKindOps, type PorchKind } from '../model/porchtool';
import { PILLAR_TYPES, pillarType, type ColumnStyle } from '../model/pillars';
import { Icon, IdTag, ProvBadge, SourceChip, Spinner } from '../ui/common';
import { explainElement, type Explanation } from '../ai/requests';
import { LocalModelUnavailable } from '../ai/hybrid';
import type { AISource } from '../model/types';
import { navigate } from '../ui/router';
import { ROOF_LABEL } from '../model/roof';
import { isPorch, porchRoof, PORCH_ROOF_LABEL, type PorchRoof } from '../model/porch';

function NumberField({ value, onCommit, step = 10, suffix = 'mm', min, max }: { value: number; onCommit: (v: number) => void; step?: number; suffix?: string; min?: number; max?: number }) {
  const [v, setV] = useState(String(Math.round(value)));
  const [last, setLast] = useState(value);
  if (value !== last) {
    setLast(value);
    setV(String(Math.round(value)));
  }
  const commit = () => {
    const n = Number(v);
    if (Number.isFinite(n) && n !== Math.round(value)) onCommit(min !== undefined || max !== undefined ? Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)) : n);
    else setV(String(Math.round(value)));
  };
  return (
    <div className="row" style={{ gap: 4 }}>
      <input className="input input-sm" type="number" step={step} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} style={{ width: 96 }} />
      <span className="small muted">{suffix}</span>
    </div>
  );
}

const FURNITURE_LABEL: Partial<Record<FurnitureKind, string>> = {
  bed: 'Bed',
  wardrobe: 'Wardrobe',
  sideboard: 'Sideboard or shelf',
  desk: 'Desk',
  chair: 'Chair',
  sofa: 'Sofa',
  tv: 'TV unit',
  table: 'Dining table',
  kitchen: 'Kitchen run',
  bath: 'Bath or shower',
  wc: 'Toilet',
  basin: 'Basin',
  plant: 'Plant',
  stair: 'Straight stair',
  'stair-l': 'L-shaped stair',
  'stair-u': 'U-shaped stair',
  spiral: 'Spiral stair',
};

/** Move, turn and resize a piece of furniture, by buttons or exact numbers. */
function FurnitureControls({ f, model, edit }: { f: Furniture; model: BuildingModel; edit: (ops: EditOp[], label?: string) => unknown }) {
  const toast = useStudio((s) => s.toast);
  const [step, setStep] = useState(50);
  const norm = (deg: number) => ((Math.round(deg) % 360) + 360) % 360;
  const move = (x: number, y: number, rotation: number, label: string) => edit([{ op: 'moveFurniture', furnitureId: f.id, x: Math.round(x), y: Math.round(y), rotation: norm(rotation) }], label);
  const turn = (by: number) => move(f.x, f.y, f.rotation + by, `Turn ${f.id} ${by > 0 ? 'right' : 'left'}`);
  const shift = (dx: number, dy: number) => move(f.x + dx * step, f.y + dy * step, f.rotation, `Shift ${f.id}`);
  const set = (patch: { kind?: FurnitureKind; w?: number; d?: number }, label: string) => edit([{ op: 'setFurniture', furnitureId: f.id, patch }], label);
  const toWall = () => {
    const g = backToWall(model, f, { turn: true, reach: 4000 });
    if (!g) return toast('No wall of this room lines up with it. Drag it inside a room first.', 'info');
    move(g.x, g.y, g.rotation, `Put ${f.id} against the wall`);
  };
  const kinds = Object.keys(FURNITURE_LABEL) as FurnitureKind[];
  const arrow = (icon: string, label: string, dx: number, dy: number) => (
    <button className="icon-btn" title={label} aria-label={label} onClick={() => shift(dx, dy)}>
      <Icon name={icon} />
    </button>
  );
  return (
    <div className="inspector-section">
      <h3>Furniture</h3>
      <div className="kv">
        <span>Type</span>
        <select className="input input-sm" value={f.kind} onChange={(e) => set({ kind: e.target.value as FurnitureKind }, `Change ${f.id} type`)}>
          {(kinds.includes(f.kind) ? kinds : [f.kind, ...kinds]).map((k) => (
            <option key={k} value={k}>
              {FURNITURE_LABEL[k] ?? k[0].toUpperCase() + k.slice(1)}
            </option>
          ))}
        </select>
        <span>Width</span>
        <NumberField value={f.w} min={100} max={20000} onCommit={(v) => set({ w: v }, `${f.id} width ${v} mm`)} />
        <span>Depth</span>
        <NumberField value={f.d} min={100} max={20000} onCommit={(v) => set({ d: v }, `${f.id} depth ${v} mm`)} />
        <span>Turn</span>
        <span className="row" style={{ gap: 2, flexWrap: 'wrap' }}>
          <button className="icon-btn" title="Turn 90° left" aria-label="Turn 90° left" onClick={() => turn(-90)}>
            <Icon name="rotate_left" />
          </button>
          <button className="icon-btn" title="Turn 90° right" aria-label="Turn 90° right" onClick={() => turn(90)}>
            <Icon name="rotate_right" />
          </button>
          <button className="btn btn-text btn-sm" title="Turn 15° right" onClick={() => turn(15)}>
            +15°
          </button>
          <NumberField value={f.rotation} step={15} suffix="°" onCommit={(v) => move(f.x, f.y, v, `Turn ${f.id} to ${norm(v)}°`)} />
        </span>
        <span>Across (X)</span>
        <NumberField value={f.x} onCommit={(v) => move(v, f.y, f.rotation, `Move ${f.id}`)} />
        <span>Down (Y)</span>
        <NumberField value={f.y} onCommit={(v) => move(f.x, v, f.rotation, `Move ${f.id}`)} />
        <span>Shift</span>
        <span className="row" style={{ gap: 6, alignItems: 'center' }}>
          <span style={{ display: 'grid', gridTemplateColumns: 'repeat(3, auto)', gap: 0 }}>
            <span />
            {arrow('arrow_upward', 'Shift up', 0, -1)}
            <span />
            {arrow('arrow_back', 'Shift left', -1, 0)}
            <span />
            {arrow('arrow_forward', 'Shift right', 1, 0)}
            <span />
            {arrow('arrow_downward', 'Shift down', 0, 1)}
            <span />
          </span>
          <select className="input input-sm" value={step} onChange={(e) => setStep(Number(e.target.value))} aria-label="How far each shift moves it" style={{ width: 84 }}>
            {[10, 50, 100, 500].map((n) => (
              <option key={n} value={n}>
                {n} mm
              </option>
            ))}
          </select>
        </span>
      </div>
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-tonal btn-sm" onClick={toWall} title="Move it to the nearest wall of its room, back to the wall">
          <Icon name="vertical_align_top" /> Against the nearest wall
        </button>
        <button className="btn btn-danger btn-sm" onClick={() => edit([{ op: 'removeFurniture', furnitureId: f.id }], `Remove ${f.id}`)}>
          <Icon name="delete" /> Remove
        </button>
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>
        In the plan, drag it to move it and drag its round handle to turn it. The arrow keys shift it 50 mm (Shift + arrow: 10 mm).
      </div>
    </div>
  );
}

export function Inspector({ onDiscuss }: { onDiscuss?: (ids: Id[]) => void }) {
  const project = useStudio((s) => s.project);
  const preview = useStudio((s) => s.preview);
  const model = preview?.model ?? project.model;
  const selection = useStudio((s) => s.selection);
  const edit = useStudio((s) => s.edit);
  const select = useStudio((s) => s.select);
  const focusOn = useStudio((s) => s.focusOn);
  const d = derive(model);
  const id = selection[0];
  const kind = id ? elementKind(model, id) : null;
  const related = id ? project.findings.filter((f) => f.status === 'open' && f.evidence.elementIds.includes(id)) : [];
  // Wall heights: one wall, or every selected wall at once.
  const selWalls = model.walls.filter((w) => selection.includes(w.id));
  const setHeights = (v: number) => {
    const walls = selWalls.length ? selWalls : [];
    const tooLow = model.openings.find((o) => walls.some((w) => w.id === o.wallId) && o.sill + o.height > v);
    if (tooLow) return useStudio.getState().toast(`${tooLow.id} is ${tooLow.sill + tooLow.height} mm tall, so the wall can't be lower than that.`, 'error');
    edit(walls.map((w) => ({ op: 'setWall' as const, wallId: w.id, patch: { height: v } })), `Wall height ${v} mm`);
  };
  const tallest = model.walls.reduce((h, w) => Math.max(h, w.height), 0);
  const heightPresets: [string, number][] = [
    ['Same as tallest', tallest],
    ['Storey', model.spec?.storeyHeight ?? model.defaults.wallHeight],
    ['2.4 m partition', 2400],
    ['1.2 m low wall', 1200],
  ];

  const [explain, setExplain] = useState<{ id: Id; data: Explanation; source: AISource; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runExplain = async () => {
    if (!id) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await explainElement(model, project.brief, project.findings, id);
      setExplain({ id, data: r.data, source: r.source, ms: r.latencyMs });
    } catch (e) {
      setErr(e instanceof LocalModelUnavailable ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ProvRow = ({ label, p }: { label: string; p?: Provenance }) => (
    <>
      <span>{label}</span>
      <span>
        <ProvBadge p={p ?? 'detected'} />
      </span>
    </>
  );

  if (!id || !kind) {
    const issues = validateModel(model);
    const brief = project.brief;
    const reqs = brief.requirements.map((q) => {
      const rooms = allRooms(model).filter((r) => r.type === q.type || (q.type === 'kitchen' && r.type === 'dining'));
      const ok = rooms.filter((r) => r.area >= q.minArea).length;
      return { q, have: rooms.length, ok };
    });
    const fit = reqs.reduce((s, r) => s + Math.min(r.q.count, r.ok), 0) / Math.max(1, reqs.reduce((s, r) => s + r.q.count, 0));
    return (
      <div className="inspector">
        <div className="inspector-section">
          <h3>Brief fit</h3>
          <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 28 }}>{reqs.length ? `${Math.round(fit * 100)}%` : '–'}</span>
            <span className="muted small">{reqs.length ? 'of required spaces present at target size' : 'No required spaces in the brief yet'}</span>
          </div>
          <div className="meter" style={{ marginTop: 8 }}>
            <span style={{ width: `${fit * 100}%`, background: fit > 0.85 ? 'var(--green)' : 'var(--fb-amber)' }} />
          </div>
          <table className="table" style={{ marginTop: 10 }}>
            <tbody>
              {reqs.map(({ q, have, ok }) => (
                <tr key={q.id}>
                  <td style={{ padding: '6px 0' }}>{q.label}</td>
                  <td style={{ padding: '6px 0' }} className="small muted">
                    ≥ {q.minArea} m²
                  </td>
                  <td style={{ padding: '6px 0', textAlign: 'right' }}>
                    {ok >= q.count ? <span className="chip ok">OK</span> : have ? <span className="chip warn">{ok}/{q.count}</span> : <span className="chip error">missing</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="inspector-section">
          <h3>Rooms</h3>
          {d.rooms.map((r) => (
            <div key={r.id} className="row" style={{ padding: '5px 0', cursor: 'pointer' }} onClick={() => focusOn([r.id])}>
              <span className="idtag">{r.id}</span>
              <span className="grow">{r.name}</span>
              <span className="muted small">{r.area.toFixed(1)} m²</span>
            </div>
          ))}
        </div>
        <div className="inspector-section">
          <h3>Assumptions</h3>
          <div className="kv">
            <span>Wall height</span>
            <span className="row">
              {model.defaults.wallHeight} mm <ProvBadge p={(model.prov['defaults.wallHeight'] as Provenance) ?? 'assumed'} />
            </span>
            <span>Window sill</span>
            <span className="row">
              {model.defaults.windowSill} mm <ProvBadge p={(model.prov['defaults.windowSill'] as Provenance) ?? 'assumed'} />
            </span>
            <span>Roof</span>
            <span className="row">
              {model.roof.kind === 'none' ? 'Not designed yet' : `${ROOF_LABEL[model.roof.kind]}${model.roof.kind !== 'flat' ? `, ${model.roof.pitch ?? 35}°` : ''}`} <ProvBadge p={model.roof.prov.kind} />
            </span>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            A floor plan alone doesn’t fix heights, roof or structure, so these stay editable assumptions until you confirm them.
          </div>
          <button className="btn btn-outline btn-sm" style={{ marginTop: 8 }} onClick={() => edit([{ op: 'setDefaults', patch: { wallHeight: model.defaults.wallHeight, windowSill: model.defaults.windowSill } }], 'Confirm default heights')}>
            <Icon name="task_alt" /> Confirm heights
          </button>
        </div>
        <div className="inspector-section">
          <h3>Geometry checks</h3>
          {issues.length === 0 ? (
            <div className="row small" style={{ color: 'var(--green)' }}>
              <Icon name="check_circle" /> Walls, openings and rooms validate.
            </div>
          ) : (
            issues.slice(0, 8).map((i) => (
              <div key={i.key} className="row small" style={{ padding: '3px 0', alignItems: 'flex-start' }}>
                <Icon name={i.severity === 'error' ? 'error' : 'warning'} style={{ color: i.severity === 'error' ? 'var(--red)' : 'var(--warn)', fontSize: 16 }} />
                <span className="grow">{i.message}</span>
              </div>
            ))
          )}
        </div>
        <div className="inspector-section small muted">Select a room, wall, door, window or furniture item to inspect and edit it. Drag walls and openings in the plan.</div>
      </div>
    );
  }

  const room = kind === 'room' ? d.roomById.get(id) : undefined;
  const wall = kind === 'wall' ? model.walls.find((w) => w.id === id) : undefined;
  const opening = kind === 'opening' ? model.openings.find((o) => o.id === id) : undefined;
  const furn = kind === 'furniture' ? model.furniture.find((f) => f.id === id) : undefined;
  const title = room?.name ?? (wall ? `Wall ${wall.id}` : opening ? `${opening.kind[0].toUpperCase()}${opening.kind.slice(1)} ${opening.id}` : furn ? `${furn.kind[0].toUpperCase()}${furn.kind.slice(1)} ${furn.id}` : id);

  // A dimension you placed: its length, and a way to remove it (Explain/Discuss don't apply).
  const dim = kind === 'dimension' ? model.dimensions?.find((x) => x.id === id) : undefined;
  if (dim) {
    const len = Math.round(Math.hypot(dim.b.x - dim.a.x, dim.b.y - dim.a.y));
    return (
      <div className="inspector">
        <div className="inspector-section">
          <div className="row">
            <span className="idtag">{dim.id}</span>
            <div className="grow" style={{ fontSize: 16, fontWeight: 500 }}>
              Dimension
            </div>
            <button className="icon-btn" onClick={() => select([])} aria-label="Clear selection">
              <Icon name="close" />
            </button>
          </div>
          <div className="kv" style={{ marginTop: 10 }}>
            <span>Length</span>
            <span>{len.toLocaleString('en-GB')} mm</span>
            <span>Line offset</span>
            <span>{Math.abs(dim.offset).toLocaleString('en-GB')} mm</span>
          </div>
          <button
            className="btn btn-outline btn-sm"
            style={{ marginTop: 10, color: 'var(--red)' }}
            onClick={() => {
              if (edit([{ op: 'removeDimension', dimensionId: dim.id }], `Remove dimension ${dim.id}`).ok) select([]);
            }}
          >
            <Icon name="delete" /> Remove dimension
          </button>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Add more with the Dimension tool (DIM). Hide or show all dimensions with DIMS on the bar under the plan.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="inspector">
      <div className="inspector-section">
        <div className="row">
          <span className="idtag">{id}</span>
          <div className="grow" style={{ fontSize: 16, fontWeight: 500 }}>
            {title}
          </div>
          <button className="icon-btn" onClick={() => select([])} aria-label="Clear selection">
            <Icon name="close" />
          </button>
        </div>
        <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
          <button className="btn btn-tonal btn-sm" onClick={runExplain} disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="auto_awesome" />} Explain
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => (onDiscuss ? onDiscuss([id]) : navigate('crit', { anchor: id }))}>
            <Icon name="add_comment" /> Discuss
          </button>
          {kind !== 'room' && (
            <button className="btn btn-text btn-sm" onClick={() => edit([{ op: 'confirm', elementId: id }], `Confirm ${id}`)}>
              <Icon name="task_alt" /> Confirm
            </button>
          )}
        </div>
        {err && <div className="small" style={{ color: 'var(--red)', marginTop: 8 }}>{err}</div>}
        {explain && explain.id === id && (
          <div className="card" style={{ marginTop: 10, background: 'var(--surface-2)', border: 0 }}>
            <div className="card-body" style={{ padding: 12 }}>
              <div className="row" style={{ marginBottom: 6 }}>
                <b className="grow">{explain.data.headline}</b>
                <SourceChip source={explain.source} />
              </div>
              <div className="small">{explain.data.explanation}</div>
              {explain.data.considerations.length > 0 && (
                <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {explain.data.considerations.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
              <div className="faint small" style={{ marginTop: 6 }}>{explain.ms} ms</div>
            </div>
          </div>
        )}
      </div>

      {room && (
        <div className="inspector-section">
          <h3>Room</h3>
          <div className="kv">
            <span>Name</span>
            <input className="input input-sm" defaultValue={room.name} key={room.id + room.name} onBlur={(e) => e.target.value !== room.name && edit([{ op: 'setRoom', roomId: room.id, patch: { name: e.target.value } }])} />
            <span>Type</span>
            <select className="select input-sm" value={room.type} onChange={(e) => edit([{ op: 'setRoom', roomId: room.id, patch: { type: e.target.value as typeof room.type } }])}>
              {ROOM_TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <span>Floor</span>
            <select className="select input-sm" value={room.floorMaterialId} onChange={(e) => edit([{ op: 'setRoom', roomId: room.id, patch: { floorMaterialId: e.target.value } }])}>
              {floorMaterials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            {isPorch(model, room) && (
              <>
                <span>Porch kind</span>
                <select
                  className="select input-sm"
                  value={room.porchKind ?? ''}
                  title="Sets its edge (handrail, screens or a low paving edge), its roof and its floor"
                  onChange={(e) => e.target.value && edit(porchKindOps(model, room.id, e.target.value as PorchKind), `${room.name}: ${porchKindOf(e.target.value as PorchKind).label.toLowerCase()}`)}
                >
                  {!room.porchKind && <option value="">Choose a kind</option>}
                  {PORCH_KINDS.map((k) => (
                    <option key={k.kind} value={k.kind} title={k.hint}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <span>Porch roof</span>
                <select
                  className="select input-sm"
                  value={room.porchRoof ?? 'auto'}
                  title="A porch set into the house sits under the main roof; one that sticks out usually has its own lean-to roof; a deck can be open."
                  onChange={(e) => edit([{ op: 'setRoom', roomId: room.id, patch: { porchRoof: e.target.value === 'auto' ? undefined : (e.target.value as PorchRoof) } }])}
                >
                  <option value="auto">Automatic: {PORCH_ROOF_LABEL[porchRoof(model, { ...room, porchRoof: undefined })].toLowerCase()}</option>
                  {(Object.keys(PORCH_ROOF_LABEL) as PorchRoof[]).map((k) => (
                    <option key={k} value={k}>
                      {PORCH_ROOF_LABEL[k]}
                    </option>
                  ))}
                </select>
              </>
            )}
            <span>Net area</span>
            <span>
              <b>{room.area.toFixed(2)} m²</b> <span className="chip" style={{ height: 18 }}>calculated</span>
            </span>
            <span>Gross area</span>
            <span>{room.grossArea.toFixed(2)} m²</span>
            <span>Perimeter</span>
            <span>{room.perimeter.toFixed(1)} m</span>
            <span>Connects to</span>
            <span className="row wrap" style={{ gap: 4 }}>
              {[...(d.connections.get(room.id) ?? [])].map((n) => (
                <IdTag key={n} id={n} />
              ))}
            </span>
            <ProvRow label="Label" p={room.prov.name} />
          </div>
        </div>
      )}

      {wall && (
        <div className="inspector-section">
          <h3>Wall</h3>
          <div className="kv">
            <span>Length</span>
            <span>{Math.round(wallLength(wall)).toLocaleString('en-GB')} mm</span>
            <span>Thickness</span>
            <NumberField value={wall.thickness} min={50} max={700} onCommit={(v) => edit([{ op: 'setWall', wallId: wall.id, patch: { thickness: v } }])} />
            <span>Height{selWalls.length > 1 ? ` (${selWalls.length} walls)` : ''}</span>
            <NumberField value={wall.height} min={300} max={30000} step={50} onCommit={(v) => setHeights(v)} />
            <span />
            <div className="row wrap" style={{ gap: 4 }}>
              {heightPresets.map(([label, v]) => (
                <button key={label} className={`chip chip-select ${wall.height === v ? 'on' : ''}`} onClick={() => setHeights(v)} title={`${v} mm`}>
                  {label}
                </button>
              ))}
            </div>
            <span>Material</span>
            <select className="select input-sm" value={wall.materialId} onChange={(e) => edit([{ op: 'setWall', wallId: wall.id, patch: { materialId: e.target.value } }])}>
              {wallMaterials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span title="If the whole plan came in at the wrong size, type this wall's real length and everything is rescaled to match.">Real length</span>
            <span className="row" style={{ gap: 6 }}>
              <NumberField
                value={Math.round(wallLength(wall))}
                step={10}
                onCommit={(v) => {
                  // Measure the wall as it is now: Enter and leaving the field can both commit.
                  const cur = useStudio.getState().project.model.walls.find((x) => x.id === wall.id);
                  const now = cur ? wallLength(cur) : 0;
                  if (v > 0 && now > 0 && Math.abs(v - now) > 1) edit([{ op: 'rescale', factor: v / now }], `Rescale the plan so ${wall.id} is ${v} mm`);
                }}
              />
              <span className="small muted">rescales the plan</span>
            </span>
            <span>Type</span>
            <select
              className="select input-sm"
              value={wall.kind === 'railing' ? 'railing' : wall.kind === 'column' ? 'column' : wall.exterior ? 'external' : 'internal'}
              onChange={(e) => {
                const v = e.target.value;
                // A railing is a low, slim handrail (porch, deck); a wall is solid.
                if (v === 'railing') edit([{ op: 'setWall', wallId: wall.id, patch: { kind: 'railing', height: Math.min(wall.height, 1100), thickness: 60, materialId: 'ash', exterior: false } }]);
                else if (v === 'column') edit([{ op: 'setWall', wallId: wall.id, patch: { kind: 'column', columnStyle: 'square', materialId: 'concrete', exterior: false } }]);
                else edit([{ op: 'setWall', wallId: wall.id, patch: { kind: undefined, exterior: v === 'external', thickness: wall.kind === 'railing' ? (v === 'external' ? model.defaults.exteriorThickness : model.defaults.interiorThickness) : wall.thickness, height: wall.kind === 'railing' ? model.walls.reduce((h, x) => Math.max(h, x.height), model.defaults.wallHeight) : wall.height, materialId: wall.kind === 'railing' ? (v === 'external' ? 'render' : 'plaster') : wall.materialId } }]);
              }}
            >
              <option value="external">Outside wall</option>
              <option value="internal">Inside wall</option>
              <option value="railing">Handrail (porch, deck)</option>
              <option value="column">Pillar</option>
            </select>
            {wall.kind === 'column' && (
              <>
                <span>Pillar type</span>
                <select
                  className="select input-sm"
                  value={wall.columnStyle ?? 'square'}
                  onChange={(e) => {
                    const t = pillarType(e.target.value as ColumnStyle);
                    edit([{ op: 'setWall', wallId: wall.id, patch: { columnStyle: t.style, materialId: t.material } }], `${wall.id}: ${t.label.toLowerCase()}`);
                  }}
                >
                  {PILLAR_TYPES.map((t) => (
                    <option key={t.style} value={t.style} title={t.hint}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <span>Pillar size</span>
                <NumberField
                  value={wall.thickness}
                  step={10}
                  min={80}
                  max={1500}
                  onCommit={(v) => {
                    // as wide as it is thick, standing where it stood
                    const cx = (wall.a.x + wall.b.x) / 2;
                    const cy = (wall.a.y + wall.b.y) / 2;
                    edit([{ op: 'setWall', wallId: wall.id, patch: { thickness: v, a: { x: Math.round(cx - v / 2), y: Math.round(cy) }, b: { x: Math.round(cx + v / 2), y: Math.round(cy) } } }], `${wall.id}: ${v} mm`);
                  }}
                />
              </>
            )}
            <span>Move by</span>
            <NumberField value={0} step={50} onCommit={(v) => v && edit([{ op: 'moveWall', wallId: wall.id, distance: v }])} />
            <ProvRow label="Position" p={wall.prov.geometry} />
            <ProvRow label="Height" p={wall.prov.height} />
          </div>
        </div>
      )}

      {opening && (
        <div className="inspector-section">
          <h3>Opening</h3>
          <div className="kv">
            <span>Kind</span>
            <select
              className="select input-sm"
              value={doorTypeOf(opening)}
              onChange={(e) => {
                const v = e.target.value as DoorType | 'window';
                const { kind, style } = doorPatch(v);
                const host = model.walls.find((w) => w.id === opening.wallId);
                // a window sits on a sill; a door or a passage starts at the floor
                const size =
                  kind === 'window'
                    ? { sill: model.defaults.windowSill, height: model.defaults.windowHead - model.defaults.windowSill }
                    : opening.kind === 'window' || kind !== opening.kind
                      ? { sill: 0, height: kind === 'opening' ? Math.min((host?.height ?? 2700) - 100, model.defaults.doorHeight + 300) : model.defaults.doorHeight }
                      : {};
                edit([{ op: 'setOpening', openingId: opening.id, patch: { kind, style, ...size } }], `${opening.id}: ${doorLabel(v).toLowerCase()}`);
              }}
            >
              {DOOR_TYPES.map((t) => (
                <option key={t.type} value={t.type} title={t.hint}>
                  {t.label}
                </option>
              ))}
              <option value="window">Window</option>
            </select>
            <span>Width</span>
            <NumberField value={opening.width} step={50} onCommit={(v) => edit([{ op: 'setOpening', openingId: opening.id, patch: { width: v } }])} />
            <span>Height</span>
            <NumberField value={opening.height} step={50} onCommit={(v) => edit([{ op: 'setOpening', openingId: opening.id, patch: { height: v } }])} />
            {opening.kind === 'window' && (
              <>
                <span>Sill</span>
                <NumberField value={opening.sill} step={50} onCommit={(v) => edit([{ op: 'setOpening', openingId: opening.id, patch: { sill: v } }])} />
              </>
            )}
            <span>Position</span>
            <NumberField value={opening.offset} step={50} onCommit={(v) => edit([{ op: 'setOpening', openingId: opening.id, patch: { offset: v } }])} />
            <span>Host wall</span>
            <span>
              <IdTag id={opening.wallId} />
            </span>
            <span>Between</span>
            <span className="row wrap" style={{ gap: 4 }}>
              {[d.links.get(opening.id)?.plus, d.links.get(opening.id)?.minus].map((r, i) => (r ? <IdTag key={i} id={r} /> : <span key={i} className="chip">outside</span>))}
            </span>
            <ProvRow label="Size" p={opening.prov.width} />
            <ProvRow label="Height" p={opening.prov.height} />
          </div>
          {opening.kind === 'door' && opening.style !== 'sliding' && (
            <div className="row" style={{ marginTop: 10 }}>
              {opening.style !== 'pocket' && (
                <button className="btn btn-outline btn-sm" onClick={() => edit([{ op: 'setOpening', openingId: opening.id, patch: { swing: (opening.swing * -1) as 1 | -1 } }])}>
                  <Icon name="swap_vert" /> {opening.style === 'folding' ? 'Fold to the other side' : 'Flip swing'}
                </button>
              )}
              {opening.style !== 'folding' && (
                <button className="btn btn-outline btn-sm" onClick={() => edit([{ op: 'setOpening', openingId: opening.id, patch: { hinge: opening.hinge === 'start' ? 'end' : 'start' } }])}>
                  <Icon name="swap_horiz" /> {opening.style === 'pocket' ? 'Slide into the other side' : 'Flip hinge'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {furn && <FurnitureControls f={furn} model={model} edit={edit} />}

      <div className="inspector-section">
        <h3>Findings on this element</h3>
        {related.length === 0 ? (
          <div className="small muted">None open.</div>
        ) : (
          related.map((f) => (
            <div key={f.id} className="row small" style={{ padding: '6px 0', alignItems: 'flex-start', cursor: 'pointer' }} onClick={() => navigate('review', { finding: f.id })}>
              <Icon name="flag" style={{ color: f.severity === 'warning' || f.severity === 'critical' ? 'var(--warn)' : 'var(--blue)', fontSize: 18 }} />
              <span className="grow">{f.title}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
