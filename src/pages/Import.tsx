import { useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../state/store';
import { navigate } from '../ui/router';
import { Icon, PageHeader, SourceChip, Spinner } from '../ui/common';
import { rasterizeFile, roomTypeFromText, suggestDimension, type Rasterized } from '../detect/rasterize';
import type { Detection, DetectedOpening, DetectedWall } from '../detect/detector';
import { derive, refreshSeeds, type DerivedRoom } from '../model/derive';
import { emptyModel, DEFAULTS } from '../model/sample';
import { pointInPolygon, interiorPoint } from '../model/geometry';
import { readRoomLabels, guessRoomTypes, readPlanParts, type PlanParts } from '../ai/requests';
import { applyVerdicts, describeForAI, scaleFromText } from '../detect/aireview';
import { checkSymbols } from '../detect/symbolcheck';
import { DOOR_TYPES, doorLabel, doorPatch, doorTypeOf, type DoorType } from '../model/doortypes';
import { applyOpeningSymbols, checkedParts, type SymbolAnswers } from '../detect/symbols';
import { boxToMm, openingsFromBoxes, outdoorSpaceOps } from '../detect/aiplan';
import { applyEdits, nextId } from '../model/edits';
import { arrangeFurniture, furnitureFromBoxes, worktopRuns } from '../detect/furniture';
import { rc, track, traced } from '../firebase/config';
import { uploadDataUrl } from '../firebase/storage';
import { ROOM_TYPES, type AISource, type BuildingModel, type Furniture, type RoomMeta, type RoomType, type Vec2, type Wall } from '../model/types';
import { validateModel } from '../model/validate';
import { parseLength, type Unit } from '../detect/units';

type Step = 1 | 2 | 3 | 4 | 5;

function runDetection(r: Rasterized): Promise<Detection> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../detect/detect.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.result as Detection);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    const copy = new Uint8ClampedArray(r.rgba);
    worker.postMessage({ rgba: copy, width: r.width, height: r.height }, [copy.buffer]);
  });
}

const fmtM = (mm: number) => `${(mm / 1000).toFixed(2)} m`;

export function ImportPage() {
  const replaceModel = useStudio((s) => s.replaceModel);
  const createProject = useStudio((s) => s.createProject);
  const toast = useStudio((s) => s.toast);
  const [step, setStep] = useState<Step>(1);
  const [raster, setRaster] = useState<Rasterized | null>(null);
  const [det, setDet] = useState<Detection | null>(null);
  const [walls, setWalls] = useState<DetectedWall[]>([]);
  const [openings, setOpenings] = useState<DetectedOpening[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unit, setUnit] = useState<Unit>('m');
  const [overall, setOverall] = useState('');
  const [measure, setMeasure] = useState<{ pts: Vec2[]; value: string; active: boolean } | null>(null);
  const [assume, setAssume] = useState({ wallHeight: DEFAULTS.wallHeight, doorHeight: DEFAULTS.doorHeight, windowSill: DEFAULTS.windowSill, windowHead: DEFAULTS.windowHead });
  const [selected, setSelected] = useState<string | null>(null);
  const [trace, setTrace] = useState<Vec2 | null | 'start'>(null);
  /** Check step: click a wall to add a door, window or sliding door there. */
  const [adding, setAdding] = useState<DoorType | 'window' | null>(null);
  /** The kind of door the "Add a door" button adds. */
  const [addDoor, setAddDoor] = useState<DoorType>('hinged');
  const [names, setNames] = useState<Record<number, { name: string; type: RoomType; from: 'drawing' | 'ai' | 'guess' | 'you' }>>({});
  const [labelSource, setLabelSource] = useState<AISource | 'drawing' | null>(null);
  /** Ask AI for the furniture drawn on the plan when building the model. */
  const [withFurniture, setWithFurniture] = useState(true);
  /** The AI's own reading of the drawing, started as soon as it is uploaded. */
  const [aiRead, setAiRead] = useState<PlanParts | null>(null);
  const [aiState, setAiState] = useState<'idle' | 'reading' | 'done' | 'off'>('idle');
  const [aiChanged, setAiChanged] = useState(0);
  const [scaleFrom, setScaleFrom] = useState<'drawing' | 'ai' | null>(null);
  /** Drawing whose missed doors and windows (read by AI) were added in the check step. */
  const aiAddedFor = useRef<string | null>(null);
  /** The legend check: every symbol found, shown large next to standard symbols for AI to name. */
  const [symbolState, setSymbolState] = useState<'idle' | 'checking' | 'done' | 'off'>('idle');
  const [symbolChanged, setSymbolChanged] = useState(0);
  const symbols = useRef<{ name: string; answers: SymbolAnswers | null; done: Promise<SymbolAnswers | null> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (f: File | { name: string; url: string; type: string }) => {
    setError(null);
    setBusy('Reading the drawing…');
    try {
      const r = await rasterizeFile(f, rc('max_plan_px'));
      setRaster(r);
      setBusy('Finding walls, doors and windows…');
      const d = await traced('plan_detect', () => runDetection(r), { kind: r.kind });
      track('plan_detected', { walls: d.walls.length, openings: d.openings.length, ms: d.ms, kind: r.kind });
      setDet(d);
      setWalls(d.walls);
      setOpenings(d.openings);
      setNames({});
      setMeasure(null);
      const dim = suggestDimension(r.texts);
      if (dim) {
        setUnit('mm');
        setOverall(String(dim));
        setScaleFrom('drawing');
      } else {
        setOverall('');
        setScaleFrom(null);
      }
      setStep(2);
      // The AI reads the drawing alongside: its dimensions (for the scale), a second opinion on
      // the doors and windows, and what the pixels missed. Nothing waits for it.
      setAiRead(null);
      setAiChanged(0);
      aiAddedFor.current = null;
      symbols.current = null;
      setSymbolState('idle');
      setSymbolChanged(0);
      void readWithAI(r, d);
      if (!d.walls.length) setError('No walls were found. Try a cleaner drawing, or trace the walls yourself in step 3.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const readWithAI = async (r: Rasterized, d: Detection) => {
    setAiState('reading');
    try {
      const { image, s, w, h } = await drawingImage(1536, r);
      const res = await readPlanParts({ ...image, width: w, height: h }, describeForAI(d.walls, d.openings, s));
      if (res.source === 'heuristic') return setAiState('off');
      setAiRead(res.data);
      setAiState('done');
      // Then a closer look: each opening and piece of furniture, cut out and set beside a legend
      // of standard plan symbols, named by AI one by one.
      setSymbolState('checking');
      const done = checkSymbols(r, d.walls, d.openings, res.data).catch(() => null);
      symbols.current = { name: r.name, answers: null, done };
      const answers = await done;
      if (symbols.current?.done !== done) return;
      symbols.current.answers = answers;
      setSymbolState(answers ? 'done' : 'off');
      if (answers)
        setOpenings((os) => {
          const { openings: next, changed } = applyOpeningSymbols(os, answers.openings);
          setSymbolChanged(changed);
          return next;
        });
    } catch {
      setAiState('off');
    }
  };

  // When the AI's reading arrives: the scale from its dimensions (unless you set one), and its
  // second opinion on the doors and windows.
  useEffect(() => {
    if (!aiRead) return;
    const sc = scaleFromText(aiRead.overall.width);
    if (sc && !overall && !measure) {
      setUnit(sc.unit);
      setOverall(sc.value);
      setScaleFrom('ai');
    }
    setOpenings((os) => {
      const { openings: next, changed } = applyVerdicts(os, aiRead.verdicts);
      setAiChanged(changed);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiRead]);

  // Extents of detected walls (centrelines) in px.
  const ext = useMemo(() => {
    const pts = walls.flatMap((w) => [w.a, w.b]);
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }, [walls]);

  const measureMm = measure ? parseLength(measure.value, unit) : 0;
  const measurePx = measure && measure.pts.length === 2 ? Math.hypot(measure.pts[1].x - measure.pts[0].x, measure.pts[1].y - measure.pts[0].y) : 0;
  const mmPerPx = useMemo(() => {
    if (measurePx > 0 && measureMm > 0) return measureMm / measurePx;
    const o = parseLength(overall, unit);
    // Overall dimensions run to the outside faces of the outer walls, not their centrelines.
    const outer = walls.filter((w) => w.exterior).map((w) => w.thickness);
    const face = outer.length ? outer.sort((a, b) => a - b)[Math.floor(outer.length / 2)] : 0;
    if (ext && o > 0) return o / Math.max(1, ext.maxX - ext.minX + face);
    return 0;
  }, [measurePx, measureMm, overall, unit, ext, walls]);

  // Once the scale is known, add the doors and windows the AI saw but the pixels missed, so
  // they show (marked to check) in the check step.
  useEffect(() => {
    if (step !== 3 || !aiRead || !raster || !mmPerPx || aiAddedFor.current === raster.name || symbolState === 'checking') return;
    aiAddedFor.current = raster.name;
    // only the doors and windows that still look like one on a closer look
    const parts = checkedParts(aiRead, symbols.current?.name === raster.name ? symbols.current.answers : null);
    const toMm = (p: Vec2): Vec2 => ({ x: p.x * mmPerPx, y: p.y * mmPerPx });
    const wallsMm = walls.map((w) => ({ id: w.id, a: toMm(w.a), b: toMm(w.b), thickness: w.thickness * mmPerPx, height: 0, materialId: '', exterior: w.exterior, prov: {} }));
    const extra: DetectedOpening[] = [];
    for (const kind of ['door', 'window'] as const) {
      const existing = [...openings, ...extra].map((o) => ({ wallId: o.wallId, offset: o.offset * mmPerPx, width: o.width * mmPerPx }));
      const found = openingsFromBoxes(kind === 'door' ? parts.doors : parts.windows, kind, raster.width, raster.height, toMm, wallsMm, existing, assume);
      for (const o of found) {
        // offsets from a wall's start: the pixel walls start at their smaller end, as in mm here
        extra.push({ id: `O${Date.now().toString(36)}${extra.length}`, wallId: o.wallId, offset: o.offset / mmPerPx, width: o.width / mmPerPx, kind, swing: o.swing, hinge: o.hinge, confidence: 0.62, ai: true });
      }
    }
    if (extra.length) {
      setOpenings((os) => [...os, ...extra]);
      setAiChanged((n) => n + extra.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, aiRead, mmPerPx, raster, symbolState]);

  /** The building model from the current detection, before rooms are named. */
  const draft = useMemo<BuildingModel | null>(() => {
    if (!raster || !ext || !mmPerPx) return null;
    const toMm = (p: Vec2): Vec2 => ({ x: Math.round((p.x - ext.minX) * mmPerPx), y: Math.round((p.y - ext.minY) * mmPerPx) });
    const thick = (t: number, exterior: boolean) => Math.min(600, Math.max(exterior ? 150 : 75, Math.round((t * mmPerPx) / 10) * 10));
    const base = emptyModel();
    return {
      ...base,
      id: `import-${Date.now().toString(36)}`,
      defaults: { ...base.defaults, ...assume },
      prov: { 'defaults.wallHeight': 'assumed', 'defaults.windowSill': 'assumed', 'defaults.doorHeight': 'assumed' },
      walls: [
        ...walls.map((w): Wall => ({ id: w.id, a: toMm(w.a), b: toMm(w.b), thickness: thick(w.thickness, w.exterior), height: assume.wallHeight, materialId: w.exterior ? 'render' : 'plaster', exterior: w.exterior, prov: { geometry: 'detected', thickness: 'detected', height: 'assumed' } })),
        // Pillars: a short square piece of wall, as tall as the walls.
        ...(det?.columns ?? []).map((c, i): Wall => {
          const size = Math.max(150, Math.round((c.size * mmPerPx) / 10) * 10);
          const ctr = toMm({ x: c.x, y: c.y });
          return { id: `C${i + 1}`, a: { x: ctr.x - size / 2, y: ctr.y }, b: { x: ctr.x + size / 2, y: ctr.y }, thickness: size, height: assume.wallHeight, materialId: 'concrete', exterior: false, kind: 'column' as const, prov: { geometry: 'detected', thickness: 'detected', height: 'assumed' } };
        }),
      ],
      openings: openings
        .filter((o) => walls.some((w) => w.id === o.wallId))
        .map((o, i) => ({
          id: `${o.kind === 'door' ? 'D' : o.kind === 'window' ? 'N' : 'O'}${i + 1}`,
          kind: o.kind,
          wallId: o.wallId,
          offset: Math.round(o.offset * mmPerPx),
          width: Math.round((o.width * mmPerPx) / 10) * 10,
          height: o.kind === 'door' ? assume.doorHeight : o.kind === 'window' ? assume.windowHead - assume.windowSill : assume.doorHeight + 300,
          sill: o.kind === 'window' ? assume.windowSill : 0,
          hinge: o.hinge,
          swing: o.swing,
          ...(o.style ? { style: o.style } : {}),
          prov: { position: 'detected', width: 'detected', kind: o.confidence >= 0.6 ? 'detected' : 'assumed', height: 'assumed', sill: 'assumed' },
        })),
      source: { url: raster.dataUrl, widthPx: raster.width, heightPx: raster.height, mmPerPx, origin: { x: -ext.minX * mmPerPx, y: -ext.minY * mmPerPx }, name: raster.name },
    };
  }, [raster, ext, mmPerPx, walls, openings, assume, det]);

  const rooms: DerivedRoom[] = useMemo(() => (draft ? derive(draft).rooms : []), [draft]);
  const toPx = (p: Vec2) => (ext && mmPerPx ? { x: p.x / mmPerPx + ext.minX, y: p.y / mmPerPx + ext.minY } : p);

  // Name rooms from the drawing's own text when it has any; otherwise guess from size until AI reads them.
  useEffect(() => {
    if (step !== 4 || !raster || !ext || !mmPerPx || !rooms.length) return;
    setNames((prev) => {
      const next = { ...prev };
      rooms.forEach((r, i) => {
        if (next[i]) return;
        const label = raster.texts.filter((t) => pointInPolygon({ x: (t.x - ext.minX) * mmPerPx, y: (t.y - ext.minY) * mmPerPx }, r.polygon)).map((t) => t.text).join(' ');
        const type = label ? roomTypeFromText(label) : null;
        if (label && type) next[i] = { name: label.toLowerCase().replace(/(^|\s|\/)\S/g, (s) => s.toUpperCase()), type: type as RoomType, from: 'drawing' };
      });
      const missing = rooms.map((r, i) => ({ index: i, areaM2: r.area })).filter((x) => !next[x.index]);
      for (const g of guessRoomTypes(missing)) next[g.index] = { name: g.name, type: g.type, from: 'guess' };
      return next;
    });
    if (raster.texts.length) setLabelSource('drawing');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, rooms.length]);

  /** The drawing as a JPEG of at most 1024 px for the AI, and the factor it was scaled by. */
  const drawingImage = async (max = 1024, from: Rasterized | null = raster) => {
    const img = new Image();
    img.src = from!.dataUrl;
    await img.decode();
    const c = document.createElement('canvas');
    const s = Math.min(1, max / Math.max(img.width, img.height));
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return { image: { mimeType: 'image/jpeg' as const, data: c.toDataURL('image/jpeg', 0.85).split(',')[1] }, s, w: c.width, h: c.height };
  };

  // On the rooms step, read the names written on the drawing straight away (images carry no
  // text the browser can read, so AI reads the labels). Once per drawing; you can run it again.
  const autoNamed = useRef<string | null>(null);
  useEffect(() => {
    if (step !== 4 || !raster || !rooms.length || raster.texts.length || autoNamed.current === raster.name) return;
    autoNamed.current = raster.name;
    void readNamesWithAI();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, rooms.length, raster]);

  const readNamesWithAI = async () => {
    if (!raster || !ext) return;
    setBusy('Reading room names with AI…');
    try {
      const { image, s } = await drawingImage();
      const centres = rooms.map((r, i) => {
        const p = toPx(r.centroid);
        return { index: i, cx: p.x * s, cy: p.y * s, areaM2: r.area };
      });
      const r = await readRoomLabels(image, centres);
      setNames((prev) => {
        const next = { ...prev };
        for (const n of r.data.rooms) if (next[n.index]?.from !== 'you') next[n.index] = { name: n.name, type: n.type, from: r.source === 'heuristic' ? 'guess' : 'ai' };
        return next;
      });
      setLabelSource(r.source);
      toast(r.source === 'heuristic' ? 'AI is not available right now, so the names are best guesses. Please check them.' : 'Room names read from your drawing. Please check them.', r.source === 'heuristic' ? 'info' : 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const build = async () => {
    if (!draft || !raster) return;
    setBusy('Building the 3D model…');
    try {
      const metas: RoomMeta[] = rooms.map((f, i) => {
        const n = names[i];
        const type = n?.type ?? 'other';
        return { id: `R${i + 1}`, name: n?.name || `Room ${i + 1}`, type, floorMaterialId: type === 'bathroom' ? 'tile' : type === 'kitchen' ? 'terrazzo' : 'oak', seed: interiorPoint(f.polygon), prov: { name: n && n.from !== 'guess' ? 'confirmed' : 'assumed', type: n && n.from !== 'guess' ? 'confirmed' : 'assumed' } };
      });
      // Your drawing gets its own project instead of replacing the shared demo house.
      if (useStudio.getState().project.id.startsWith('demo')) createProject('blank', raster.name.replace(/.[^.]+$/, '').replace(/[-_]+/g, ' ') || 'My plan', useStudio.getState().project.brief.mode);
      const pid = useStudio.getState().project.id;
      setBusy('Saving the drawing…');
      const stored = await uploadDataUrl(`projects/${pid}/drawings/${Date.now().toString(36)}-${raster.name.replace(/[^\w.-]+/g, '_')}`, raster.dataUrl, { source: raster.kind }).catch(() => null);
      // Firebase AI Logic reads the drawing too (the image goes to the cloud model): doors and
      // windows the pixel check missed, porches and decks, and the furniture.
      let model: BuildingModel = { ...draft, rooms: metas, source: draft.source && stored ? { ...draft.source, url: stored } : draft.source };
      let furniture: Furniture[] = [];
      let aiNote = '';
      const added = { doors: 0, windows: 0, outdoor: 0 };
      // Worktops along kitchen and laundry walls, followed on the drawing itself.
      let runs: Furniture[] = [];
      if (withFurniture && ext) {
        const px = raster.rgba;
        const ink = (p: Vec2) => {
          const x = Math.round(p.x / mmPerPx + ext.minX);
          const y = Math.round(p.y / mmPerPx + ext.minY);
          if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return false;
          const i = (y * raster.width + x) * 4;
          // worktop lines are often drawn pale grey
          return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < 215;
        };
        runs = worktopRuns(model, ink, Math.max(10, Math.round(mmPerPx)));
      }
      if (withFurniture && ext) {
        setBusy('Reading doors, windows, porches and furniture with AI…');
        try {
          let read = aiRead;
          if (!read) {
            const { image, s, w, h } = await drawingImage(1536);
            const res = await readPlanParts({ ...image, width: w, height: h }, describeForAI(walls, openings, s));
            read = res.source === 'heuristic' ? null : res.data;
            // read only now (AI was busy earlier): give it the closer look against the legend now
            if (read) {
              setBusy('Checking each symbol against the legend…');
              read = checkedParts(read, await checkSymbols(raster, walls, openings, read).catch(() => null));
              setBusy('Reading doors, windows, porches and furniture with AI…');
            }
          }
          // the legend check filters and names what the AI read (wait for it if it is still going)
          else if (symbols.current?.name === raster.name) {
            setBusy('Checking each symbol against the legend…');
            read = checkedParts(read, symbols.current.answers ?? (await symbols.current.done));
            setBusy('Reading doors, windows, porches and furniture with AI…');
          }
          if (!read) aiNote = ' AI wasn’t available, so only what the drawing check found was added.';
          else {
            const r = { data: read };
            const toMm = (p: Vec2): Vec2 => ({ x: Math.round((p.x - ext.minX) * mmPerPx), y: Math.round((p.y - ext.minY) * mmPerPx) });
            // Missed doors and windows, each on the wall it sits on (unless the check step has them).
            for (const kind of aiAddedFor.current === raster.name ? ([] as const) : (['door', 'window'] as const)) {
              const found = openingsFromBoxes(kind === 'door' ? r.data.doors : r.data.windows, kind, raster.width, raster.height, toMm, model.walls, model.openings, assume);
              for (const o of found) {
                const res = applyEdits(model, [{ op: 'addOpening', opening: { ...o, id: nextId(model, kind === 'door' ? 'D' : 'N') } }]);
                if (res.ok) {
                  model = res.model;
                  added[kind === 'door' ? 'doors' : 'windows']++;
                }
              }
            }
            // Porches, decks and patios: low walls round them and a way in.
            for (const o of r.data.outdoor) {
              const made = outdoorSpaceOps(model, boxToMm(o.box, raster.width, raster.height, toMm));
              if (!made) continue;
              const res = applyEdits(model, made.ops);
              if (!res.ok) continue;
              const name = o.kind[0].toUpperCase() + o.kind.slice(1);
              // the kind read off the drawing sets its floor and roof (a terrace is a patio)
              const porchKind = ({ porch: 'porch', veranda: 'veranda', deck: 'deck', patio: 'patio', terrace: 'patio' } as const)[o.kind];
              model = { ...res.model, rooms: [...res.model.rooms, { id: `R${res.model.rooms.length + 1}`, name, type: 'other', floorMaterialId: porchKind === 'patio' ? 'terrazzo' : 'oak', seed: made.seed, prov: { name: 'detected', type: 'assumed' }, porchKind }] };
              added.outdoor++;
            }
            const xs = model.walls.flatMap((w) => [w.a.x, w.b.x]);
            const ys = model.walls.flatMap((w) => [w.a.y, w.b.y]);
            // Each piece in a room where it belongs, back to a wall where it stands against one.
            furniture = arrangeFurniture(model, [...runs, ...furnitureFromBoxes(r.data.furniture, raster.width, raster.height, toMm, { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) })]);
          }
        } catch {
          aiNote = ' AI couldn’t read the drawing this time, so only what the drawing check found was added.';
        }
      }
      if (!furniture.length && runs.length) furniture = arrangeFurniture(model, runs);
      model = { ...model, furniture };
      const finalModel = refreshSeeds(model);
      const errors = validateModel(finalModel).filter((i) => i.severity === 'error');
      replaceModel(finalModel, `Imported ${raster.name}`);
      track('plan_imported', { walls: finalModel.walls.length, openings: finalModel.openings.length, rooms: rooms.length, labels: labelSource ?? 'none', stored: Boolean(stored) });
      const aiAdded = [added.doors && `${added.doors} door${added.doors > 1 ? 's' : ''}`, added.windows && `${added.windows} window${added.windows > 1 ? 's' : ''}`, added.outdoor && `${added.outdoor} outdoor space${added.outdoor > 1 ? 's' : ''}`, furniture.length && `${furniture.length} pieces of furniture`].filter(Boolean).join(', ');
      toast(`Your model is ready: ${finalModel.rooms.length} rooms, ${finalModel.walls.length} walls, ${finalModel.openings.length} doors and windows.${aiAdded ? ` AI added ${aiAdded}.` : ''}${errors.length ? ` ${errors.length} thing(s) to check in the studio.` : ''}${aiNote} Anything not right? Click it to change or remove it; if sizes look off, select a wall and type its real length.`, errors.length || aiNote ? 'info' : 'success');
      navigate('studio');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const uncertain = openings.filter((o) => o.confidence < 0.6).length;
  const counts = openings.reduce<Record<string, number>>((a, o) => ((a[o.kind] = (a[o.kind] ?? 0) + 1), a), {});

  /** Change a detected opening's type (or remove it), from the bar or the table. */
  const setOpeningType = (id: string, v: DoorType | 'window' | 'remove') => {
    if (v === 'remove') {
      setOpenings((os) => os.filter((x) => x.id !== id));
      setSelected(null);
      return;
    }
    const { kind, style } = doorPatch(v);
    setOpenings((os) => os.map((x) => (x.id === id ? { ...x, kind, style, confidence: 1 } : x)));
  };
  const onOverlayClick = (p: Vec2) => {
    if (adding) {
      // Put the new door or window on the wall nearest the click.
      let best: { w: DetectedWall; d: number; along: number } | null = null;
      for (const w of walls) {
        const horiz = Math.abs(w.a.y - w.b.y) < 1;
        const lo = horiz ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y);
        const hi = horiz ? Math.max(w.a.x, w.b.x) : Math.max(w.a.y, w.b.y);
        const along = horiz ? p.x : p.y;
        const d = horiz ? Math.abs(p.y - w.a.y) : Math.abs(p.x - w.a.x);
        if (along < lo || along > hi || d > w.thickness / 2 + 14) continue;
        if (!best || d < best.d) best = { w, d, along: along - lo };
      }
      if (!best) {
        toast('Click on a wall to put it there.', 'info');
        return;
      }
      const mm = adding === 'window' ? 1200 : DOOR_TYPES.find((t) => t.type === adding)!.width;
      const width = mmPerPx ? mm / mmPerPx : best.w.thickness * (mm / 130);
      const id = `O${Date.now().toString(36)}`;
      const { kind, style } = doorPatch(adding);
      setOpenings((os) => [...os, { id, wallId: best!.w.id, offset: best!.along, width, kind, swing: 1, hinge: 'start', confidence: 1, ...(style ? { style } : {}) }]);
      setSelected(id);
      setAdding(null);
      return;
    }
    if (measure?.active && measure.pts.length < 2) {
      const pts = [...measure.pts, p];
      setMeasure({ ...measure, pts, active: pts.length < 2 });
      return;
    }
    if (trace === 'start') {
      setTrace(p);
      return;
    }
    if (trace) {
      const horizontal = Math.abs(p.x - trace.x) > Math.abs(p.y - trace.y);
      const b = horizontal ? { x: p.x, y: trace.y } : { x: trace.x, y: p.y };
      const t = det?.thickness.min ?? 10;
      setWalls((ws) => [...ws, { id: `W${ws.length + openings.length + 100}`, a: trace, b, thickness: t, exterior: false, confidence: 1 }]);
      setTrace(null);
    }
  };

  const steps: { n: Step; title: string; text: string }[] = [
    { n: 1, title: 'Upload a drawing', text: 'A floor plan, a scan or a photo of a sketch: PNG, JPEG, SVG or PDF' },
    { n: 2, title: 'Set the scale', text: 'Use one dimension you know' },
    { n: 3, title: 'Check walls and openings', text: 'Fix anything that was missed' },
    { n: 4, title: 'Name the rooms', text: 'So the review knows your bedrooms' },
    { n: 5, title: 'Heights and finish', text: 'Things a plan can’t show' },
  ];

  const roomMarkers = step === 4 ? rooms.map((r, i) => ({ n: i + 1, p: toPx(r.centroid), name: names[i]?.name ?? `Room ${i + 1}` })) : [];

  return (
    <>
      <PageHeader
        title="Plan import"
        icon="document_scanner"
        subtitle="Upload a floor plan and ArchiMind turns it into a 3D model. Anything it isn’t sure about is marked for you to check."
        actions={
          raster ? (
            <button
              className="btn btn-text"
              disabled={!!busy}
              onClick={() => {
                // Stop the import: nothing has been added to your project yet.
                setRaster(null);
                setDet(null);
                setWalls([]);
                setOpenings([]);
                setNames({});
                setMeasure(null);
                setError(null);
                setStep(1);
                navigate('studio');
              }}
            >
              <Icon name="close" /> Cancel import
            </button>
          ) : undefined
        }
      />
      <div className="page-inner import-grid" style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', gap: 20, maxWidth: 1400 }}>
        <div className="card" style={{ alignSelf: 'start', overflow: 'hidden' }}>
          <div className="import-steps">
            {steps.map((s) => (
              <button
                key={s.n}
                className="row"
                disabled={(!raster && s.n > 1) || (s.n > 2 && !mmPerPx)}
                onClick={() => raster && setStep(s.n)}
                style={{ width: '100%', border: 0, background: step === s.n ? 'var(--blue-50)' : 'none', padding: '14px 18px', textAlign: 'left', cursor: raster || s.n === 1 ? 'pointer' : 'default', alignItems: 'flex-start', borderBottom: '1px solid var(--border-2)', color: 'var(--text)' }}
              >
                <span className="sev" style={{ width: 26, height: 26, background: step > s.n ? 'var(--green)' : step === s.n ? 'var(--blue)' : 'var(--surface-2)', color: step >= s.n ? '#fff' : 'var(--text-2)', fontSize: 13, fontWeight: 500 }}>
                  {step > s.n ? <Icon name="check" size={16} /> : s.n}
                </span>
                <span className="col" style={{ gap: 0 }}>
                  <span style={{ fontWeight: 500, color: step === s.n ? 'var(--on-tonal)' : 'var(--text)' }}>{s.title}</span>
                  <span className="small muted">{s.text}</span>
                </span>
              </button>
            ))}
          </div>
          {det && (
            <div className="card-body small col" style={{ gap: 6 }}>
              <div className="row wrap" style={{ gap: 4 }}>
                <span className="chip">{walls.length} walls</span>
                <span className="chip">{counts.door ?? 0} doors</span>
                <span className="chip">{counts.window ?? 0} windows</span>
                {(counts.opening ?? 0) > 0 && <span className="chip">{counts.opening} openings</span>}
                {rooms.length > 0 && <span className="chip">{rooms.length} rooms</span>}
                {uncertain > 0 && <span className="chip warn">{uncertain} to check</span>}
              </div>
            </div>
          )}
        </div>

        <div className="col" style={{ gap: 16, minWidth: 0 }}>
          {error && (
            <div className="card card-pad row" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
              <Icon name="error" /> {error}
            </div>
          )}

          {step === 1 && (
            <div
              className="card"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files[0];
                if (f) load(f);
              }}
            >
              <div className="empty" style={{ padding: 48, border: '2px dashed var(--border)', margin: 20, borderRadius: 12 }}>
                <Icon name="upload_file" size={48} />
                <div style={{ fontSize: 18, color: 'var(--text)', marginBottom: 6 }}>Drop a floor plan here</div>
                <div style={{ marginBottom: 18 }}>PNG, JPEG, SVG or PDF (first page). Clean, single-floor plans work best.</div>
                <div className="row wrap" style={{ justifyContent: 'center' }}>
                  <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={!!busy}>
                    <Icon name="folder_open" /> Choose file
                  </button>
                  <button className="btn btn-outline" onClick={() => load({ name: 'family-home.svg', url: '/samples/family-home.svg', type: 'image/svg+xml' })} disabled={!!busy}>
                    <Icon name="draft" /> Use sample drawing
                  </button>
                </div>
                <input ref={fileRef} type="file" accept=".png,.jpg,.jpeg,.svg,.pdf,image/png,image/jpeg,image/svg+xml,application/pdf" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0])} />
                {busy && (
                  <div className="row" style={{ justifyContent: 'center', marginTop: 18 }}>
                    <Spinner /> {busy}
                  </div>
                )}
              </div>
            </div>
          )}

          {raster && step > 1 && (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="card-header">
                <h2 className="text-ellipsis" style={{ minWidth: 0 }}>
                  {raster.name}
                </h2>
                <div className="grow" />
                {step === 3 && (
                  <div className="row wrap" style={{ gap: 6 }}>
                    <button className={`btn btn-sm ${trace ? 'btn-primary' : 'btn-outline'}`} onClick={() => (setAdding(null), setTrace(trace ? null : 'start'))}>
                      <Icon name="polyline" /> {trace ? (trace === 'start' ? 'Click where the wall starts' : 'Click where it ends') : 'Draw a missing wall'}
                    </button>
                    {/* any kind of door, or an open passage: pick the kind, then click a wall */}
                    <span className="row" style={{ gap: 0 }}>
                      <button className={`btn btn-sm ${adding && adding !== 'window' ? 'btn-primary' : 'btn-outline'}`} style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }} onClick={() => (setTrace(null), setAdding(adding && adding !== 'window' ? null : addDoor))}>
                        <Icon name={DOOR_TYPES.find((t) => t.type === addDoor)!.icon} /> {adding && adding !== 'window' ? 'Click a wall' : addDoor === 'opening' ? 'Add an open passage' : `Add a ${doorLabel(addDoor).toLowerCase()}`}
                      </button>
                      <select
                        className="select input-sm"
                        aria-label="Kind of door to add"
                        value={addDoor}
                        onChange={(e) => {
                          const t = e.target.value as DoorType;
                          setAddDoor(t);
                          setTrace(null);
                          setAdding(t);
                        }}
                        style={{ width: 132, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, marginLeft: -1 }}
                      >
                        {DOOR_TYPES.map((t) => (
                          <option key={t.type} value={t.type}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </span>
                    <button className={`btn btn-sm ${adding === 'window' ? 'btn-primary' : 'btn-outline'}`} onClick={() => (setTrace(null), setAdding(adding === 'window' ? null : 'window'))}>
                      <Icon name="window" /> {adding === 'window' ? 'Click a wall' : 'Add a window'}
                    </button>
                  </div>
                )}
                {step === 2 && measure?.active && <span className="chip blue">Click {measure.pts.length === 0 ? 'the first' : 'the second'} end of a dimension you know</span>}
              </div>
              {step === 3 && selected && (() => {
                const o = openings.find((x) => x.id === selected);
                const w = !o ? walls.find((x) => x.id === selected) : undefined;
                if (!o && !w) return null;
                return (
                  <div className="row wrap" style={{ gap: 6, padding: '8px 16px', borderBottom: '1px solid var(--border-2)', background: 'var(--blue-50)' }}>
                    <b className="small">{o ? `Opening ${o.id}` : `Wall ${w!.id}`}</b>
                    <span className="small muted">is a</span>
                    {o && (
                      <>
                        {(['hinged', 'sliding', 'window', 'opening'] as const).map((k) => (
                          <button key={k} className={`btn btn-sm ${doorTypeOf(o) === k ? 'btn-primary' : 'btn-outline'}`} onClick={() => setOpeningType(o.id, k)}>
                            {doorLabel(k)}
                          </button>
                        ))}
                        <select className="select input-sm" aria-label="Another kind of door" value={['double', 'pocket', 'folding'].includes(doorTypeOf(o)) ? doorTypeOf(o) : ''} onChange={(e) => e.target.value && setOpeningType(o.id, e.target.value as DoorType)} style={{ width: 130 }}>
                          <option value="">More kinds</option>
                          {DOOR_TYPES.filter((t) => ['double', 'pocket', 'folding'].includes(t.type)).map((t) => (
                            <option key={t.type} value={t.type}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                    {w && (
                      <>
                        <button className={`btn btn-sm ${w.exterior ? 'btn-primary' : 'btn-outline'}`} onClick={() => setWalls((ws) => ws.map((x) => (x.id === w.id ? { ...x, exterior: true } : x)))}>
                          Outside wall
                        </button>
                        <button className={`btn btn-sm ${!w.exterior ? 'btn-primary' : 'btn-outline'}`} onClick={() => setWalls((ws) => ws.map((x) => (x.id === w.id ? { ...x, exterior: false } : x)))}>
                          Inside wall
                        </button>
                      </>
                    )}
                    <div className="grow" />
                    <button
                      className="btn btn-sm btn-text"
                      style={{ color: 'var(--red)' }}
                      onClick={() => {
                        if (o) setOpeningType(o.id, 'remove');
                        else {
                          setWalls((ws) => ws.filter((x) => x.id !== w!.id));
                          setOpenings((os) => os.filter((x) => x.wallId !== w!.id));
                          setSelected(null);
                        }
                      }}
                    >
                      <Icon name="delete" /> Remove
                    </button>
                  </div>
                );
              })()}
              {(step === 2 || step === 3) && aiState === 'off' && (
                <div className="small muted" style={{ padding: '6px 16px', borderBottom: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Icon name="cloud_off" />
                  AI could not read the drawing just now (Google’s AI is busy, or the project’s free daily AI limit is used up), so the drawing check’s own reading is shown. Everything still works: check the doors and windows below.
                </div>
              )}
              {(step === 2 || step === 3) && aiState !== 'idle' && aiState !== 'off' && (
                <div className="small" style={{ padding: '6px 16px', borderBottom: '1px solid var(--border-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {aiState === 'reading' ? <Spinner size={14} /> : <Icon name="auto_awesome" style={{ color: 'var(--blue)' }} />}
                  {aiState === 'reading'
                    ? 'AI is reading the drawing too: its dimensions, its doors and windows, and anything missed.'
                    : symbolState === 'checking'
                      ? 'AI is now checking each door, window and piece of furniture against a legend of standard plan symbols.'
                      : aiChanged + symbolChanged
                        ? `AI read the drawing${symbolState === 'done' ? ', checked every symbol against a legend,' : ''} and changed or added ${aiChanged + symbolChanged} door${aiChanged + symbolChanged === 1 ? '' : 's'} or window${aiChanged + symbolChanged === 1 ? '' : 's'}, marked "AI" in the list. Please check them.`
                        : `AI read the drawing${symbolState === 'done' ? ', checked every symbol against a legend,' : ''} and agrees with the doors and windows found.`}
                </div>
              )}
              {step === 3 && !selected && !adding && !trace && (
                <div className="small muted" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-2)' }}>
                  Click anything on the drawing to change it or remove it. Missing something? Draw the wall, or add a door or window, with the buttons above.
                  <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
                    {OPENING_KEY.map(([label, c, dash]) => (
                      <span key={label} className="row" style={{ gap: 4 }}>
                        <svg width="22" height="8" aria-hidden="true">
                          <line x1="1" y1="4" x2="21" y2="4" stroke={c} strokeWidth="6" strokeOpacity="0.7" strokeDasharray={dash ? '5 3' : undefined} />
                        </svg>
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <Overlay
                raster={raster}
                walls={walls}
                openings={openings}
                selected={selected}
                onSelect={setSelected}
                measurePts={step === 2 ? measure?.pts ?? [] : []}
                measureLabel={measureMm > 0 ? fmtM(measureMm) : measurePx ? `${Math.round(measurePx)} px` : ''}
                onMeasureMove={(i, p) => setMeasure((m) => (m ? { ...m, pts: m.pts.map((q, j) => (j === i ? p : q)) } : m))}
                crosshair={Boolean(measure?.active || trace || adding)}
                tracing={trace && trace !== 'start' ? trace : null}
                rooms={roomMarkers}
                onClick={onOverlayClick}
              />
            </div>
          )}

          {step === 2 && raster && (
            <div className="card card-pad col" style={{ gap: 14 }}>
              <div className="row wrap" style={{ gap: 10 }}>
                <span className="label">Units</span>
                <div className="seg">
                  {(
                    [
                      ['m', 'Metres'],
                      ['mm', 'Millimetres'],
                      ['ft', 'Feet and inches'],
                    ] as [Unit, string][]
                  ).map(([u, label]) => (
                    <button key={u} className={unit === u ? 'on' : ''} onClick={() => setUnit(u)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-2" style={{ alignItems: 'start' }}>
                <div className="field">
                  <label>Option 1: overall width of the building</label>
                  <input className="input" value={overall} placeholder={unit === 'ft' ? `e.g. 41'0"` : unit === 'm' ? 'e.g. 12.5' : 'e.g. 12000'} onChange={(e) => (setMeasure(null), setScaleFrom(null), setOverall(e.target.value))} />
                  <span className="small muted">From the outside of one outer wall to the outside of the other: the overall dimension written along the drawing's top or bottom.</span>
                  {suggestDimension(raster.texts) && (
                    <span className="small" style={{ color: 'var(--green)' }}>
                      <Icon name="auto_awesome" size={14} /> Found “{suggestDimension(raster.texts)?.toLocaleString('en-GB')}” on the drawing. Please check it.
                    </span>
                  )}
                </div>
                <div className="field">
                  <label>Option 2: measure something on the drawing</label>
                  {!measure ? (
                    <button className="btn btn-outline" onClick={() => setMeasure({ pts: [], value: '', active: true })} style={{ alignSelf: 'flex-start' }}>
                      <Icon name="straighten" /> Pick two points
                    </button>
                  ) : (
                    <div className="col" style={{ gap: 8 }}>
                      <div className="row wrap">
                        <input className="input" style={{ width: 160 }} value={measure.value} placeholder={unit === 'ft' ? `e.g. 30'10"` : unit === 'm' ? 'e.g. 3.6' : 'e.g. 3600'} onChange={(e) => setMeasure({ ...measure, value: e.target.value })} disabled={measure.pts.length < 2} />
                        <span className="small muted">{measure.pts.length < 2 ? `${measure.pts.length} of 2 points` : 'real length between the points'}</span>
                      </div>
                      <div className="row wrap" style={{ gap: 6 }}>
                        <button className="btn btn-text btn-sm" onClick={() => setMeasure({ pts: [], value: measure.value, active: true })}>
                          <Icon name="restart_alt" /> Pick again
                        </button>
                        <button className="btn btn-text btn-sm btn-danger" onClick={() => setMeasure(null)}>
                          <Icon name="delete" /> Remove
                        </button>
                      </div>
                      {measure.pts.length === 2 && <span className="small muted">Drag the red dots to adjust them.</span>}
                    </div>
                  )}
                </div>
              </div>
              {mmPerPx > 0 && ext && (
                <div className="row wrap">
                  <span className="chip ok">
                    <Icon name="straighten" /> Scale set
                  </span>
                  <span className="muted">
                    The building is about {fmtM((ext.maxX - ext.minX) * mmPerPx)} by {fmtM((ext.maxY - ext.minY) * mmPerPx)}.
                  </span>
                  {scaleFrom === 'ai' && !measure && (
                    <span className="chip blue" title="The AI read the overall width written on your drawing. Change it if it's wrong.">
                      <Icon name="auto_awesome" /> Width {overall} read from the drawing by AI
                    </span>
                  )}
                  {scaleFrom === 'drawing' && !measure && <span className="chip">Width read from the drawing's text</span>}
                  {(Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY) * mmPerPx > 250_000 || Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY) * mmPerPx < 2_000) && (
                    <span className="chip warn" role="alert">
                      <Icon name="warning" /> That size looks wrong. Check the number and the unit (mm, m, or feet and inches).
                    </span>
                  )}
                  <div className="grow" />
                  <button className="btn btn-primary" onClick={() => setStep(3)}>
                    Next <Icon name="arrow_forward" />
                  </button>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="card">
              <div className="card-header">
                <h2>Doors, windows and openings</h2>
                <span className="sub hide-mobile">items marked to check are dashed orange on the drawing</span>
                <div className="grow" />
                <button className="btn btn-primary" onClick={() => setStep(4)}>
                  Next <Icon name="arrow_forward" />
                </button>
              </div>
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Width</th>
                      <th>Type</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {openings.map((o) => (
                      <tr key={o.id} className="clickable" onClick={() => setSelected(o.id)} style={{ background: selected === o.id ? 'var(--blue-50)' : undefined }}>
                        <td>{o.id}</td>
                        <td>{mmPerPx ? fmtM(o.width * mmPerPx) : `${Math.round(o.width)} px`}</td>
                        <td>
                          <select className="select input-sm" value={doorTypeOf(o)} onClick={(e) => e.stopPropagation()} onChange={(e) => setOpeningType(o.id, e.target.value as DoorType | 'window')} style={{ width: 140 }}>
                            {DOOR_TYPES.map((t) => (
                              <option key={t.type} value={t.type}>
                                {t.label}
                              </option>
                            ))}
                            <option value="window">Window</option>
                          </select>
                        </td>
                        <td>{o.confidence >= 1 ? <span className="chip ok">confirmed</span> : o.ai ? <span className="chip blue">AI: please check</span> : o.confidence >= 0.6 ? <span className="chip">looks right</span> : <span className="chip warn">please check</span>}</td>
                        <td>
                          <button className="icon-btn" onClick={(e) => (e.stopPropagation(), setOpenings((os) => os.filter((x) => x.id !== o.id)))} aria-label={`Remove ${o.id}`}>
                            <Icon name="delete" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-body row wrap" style={{ borderTop: '1px solid var(--border-2)', gap: 6 }}>
                <span className="small muted">Walls (click to highlight, × to remove):</span>
                {walls.map((w) => (
                  <span key={w.id} className={`chip ${selected === w.id ? 'blue' : ''}`} onClick={() => setSelected(w.id)} style={{ cursor: 'pointer' }}>
                    {w.id}
                    {w.exterior ? ' (outside)' : ''}
                    <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={(e) => (e.stopPropagation(), setWalls((ws) => ws.filter((x) => x.id !== w.id)), setOpenings((os) => os.filter((x) => x.wallId !== w.id)))} aria-label={`Remove ${w.id}`}>
                      <Icon name="close" size={14} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="card">
              <div className="card-header">
                <h2>Rooms</h2>
                <span className="sub hide-mobile">numbers match the drawing above</span>
                <div className="grow" />
                {labelSource && labelSource !== 'drawing' && <SourceChip source={labelSource} />}
                <button className="btn btn-tonal btn-sm" onClick={readNamesWithAI} disabled={!!busy || !rooms.length}>
                  {busy ? <Spinner size={16} /> : <Icon name="auto_awesome" />} Read names with AI
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setStep(5)} disabled={!rooms.length}>
                  Next <Icon name="arrow_forward" />
                </button>
              </div>
              {rooms.length === 0 ? (
                <div className="empty">No closed rooms were found. Go back and draw any missing walls so each room is enclosed.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Size</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rooms.map((r, i) => {
                      const n = names[i] ?? { name: `Room ${i + 1}`, type: 'other' as RoomType, from: 'guess' as const };
                      const upd = (patch: Partial<typeof n>) => setNames((prev) => ({ ...prev, [i]: { ...n, ...patch, from: 'you' } }));
                      return (
                        <tr key={i}>
                          <td>{i + 1}</td>
                          <td>
                            <input className="input input-sm" value={n.name} onChange={(e) => upd({ name: e.target.value })} style={{ minWidth: 140 }} />
                          </td>
                          <td>
                            <select className="select input-sm" value={n.type} onChange={(e) => upd({ type: e.target.value as RoomType })}>
                              {ROOM_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {t[0].toUpperCase() + t.slice(1)}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="small">{r.area.toFixed(1)} m²</td>
                          <td className="small muted">{n.from === 'drawing' ? 'from drawing' : n.from === 'ai' ? 'read by AI' : n.from === 'you' ? 'set by you' : 'best guess'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {step === 5 && (
            <div className="card card-pad">
              <div className="small muted" style={{ marginBottom: 12 }}>
                A floor plan doesn’t show heights. These are sensible starting values marked as <span className="prov assumed">assumed</span>; you can change them later in the studio.
              </div>
              <div className="grid grid-4">
                {(
                  [
                    ['wallHeight', 'Wall height'],
                    ['doorHeight', 'Door height'],
                    ['windowSill', 'Window sill'],
                    ['windowHead', 'Window top'],
                  ] as const
                ).map(([k, label]) => (
                  <div className="field" key={k}>
                    <label>{label} (m)</label>
                    <input className="input" type="number" step={0.05} value={(assume[k] / 1000).toFixed(2)} onChange={(e) => setAssume({ ...assume, [k]: Math.round(Number(e.target.value) * 1000) })} />
                  </div>
                ))}
              </div>
              <label className="row" style={{ marginTop: 16, gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={withFurniture} onChange={(e) => setWithFurniture(e.target.checked)} />
                <span>Use AI to add what the drawing check missed: doors, windows, porches and decks, and the furniture (beds, sofas, tables, chairs and so on).</span>
              </label>
              <div className="row" style={{ marginTop: 16 }}>
                <div className="grow" />
                <button className="btn btn-primary" onClick={build} disabled={!!busy || !draft || !walls.length}>
                  {busy ? <Spinner /> : <Icon name="view_in_ar" />} {busy ?? 'Create the 3D model'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Colours of the openings on the check drawing, and the key shown under it. */
const OPENING_COLOUR = { door: '#188038', sliding: '#d01884', window: '#00acc1', opening: '#8430ce', unsure: '#e37400' };
const OPENING_KEY: [string, string, boolean][] = [
  ['Door', OPENING_COLOUR.door, false],
  ['Sliding door', OPENING_COLOUR.sliding, false],
  ['Window', OPENING_COLOUR.window, false],
  ['Open passage', OPENING_COLOUR.opening, false],
  ['Not sure, please check', OPENING_COLOUR.unsure, true],
];

function Overlay({
  raster,
  walls,
  openings,
  selected,
  onSelect,
  measurePts,
  measureLabel,
  onMeasureMove,
  crosshair,
  tracing,
  rooms,
  onClick,
}: {
  raster: Rasterized;
  walls: DetectedWall[];
  openings: DetectedOpening[];
  selected: string | null;
  onSelect: (id: string) => void;
  measurePts: Vec2[];
  measureLabel: string;
  onMeasureMove: (i: number, p: Vec2) => void;
  crosshair: boolean;
  tracing: Vec2 | null;
  rooms: { n: number; p: Vec2; name: string }[];
  onClick: (p: Vec2) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef<number | null>(null);
  const moved = useRef(false);
  const toPx = (e: { clientX: number; clientY: number }) => {
    const svg = ref.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, y: p.y };
  };
  const scale = raster.width / 900; // keep handles readable on large images
  const wallById = new Map(walls.map((w) => [w.id, w]));
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${raster.width} ${raster.height}`}
      style={{ width: '100%', maxHeight: 560, display: 'block', background: '#fff', cursor: crosshair ? 'crosshair' : 'default', touchAction: 'none' }}
      onPointerMove={(e) => {
        if (dragging.current === null) return;
        moved.current = true;
        onMeasureMove(dragging.current, toPx(e));
      }}
      onPointerUp={() => (dragging.current = null)}
      onClick={(e) => {
        if (moved.current) {
          moved.current = false;
          return;
        }
        onClick(toPx(e));
      }}
    >
      <image href={raster.dataUrl} x={0} y={0} width={raster.width} height={raster.height} opacity={0.45} />
      {walls.map((w) => (
        <line key={w.id} x1={w.a.x} y1={w.a.y} x2={w.b.x} y2={w.b.y} stroke={w.confidence < 0.7 ? '#e37400' : '#1a73e8'} strokeOpacity={selected === w.id ? 0.9 : 0.45} strokeWidth={w.thickness} onClick={(e) => (crosshair ? undefined : (e.stopPropagation(), onSelect(w.id)))} style={{ cursor: crosshair ? 'crosshair' : 'pointer' }} />
      ))}
      {openings.map((o) => {
        const w = wallById.get(o.wallId);
        if (!w) return null;
        const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
        const dx = (w.b.x - w.a.x) / L;
        const dy = (w.b.y - w.a.y) / L;
        const c = { x: w.a.x + dx * o.offset, y: w.a.y + dy * o.offset };
        const colour = o.kind === 'door' ? (o.style === 'sliding' ? OPENING_COLOUR.sliding : OPENING_COLOUR.door) : o.kind === 'window' ? OPENING_COLOUR.window : OPENING_COLOUR.opening;
        return (
          <g key={o.id} onClick={(e) => (crosshair ? undefined : (e.stopPropagation(), onSelect(o.id)))} style={{ cursor: crosshair ? 'crosshair' : 'pointer' }}>
            <line x1={c.x - (dx * o.width) / 2} y1={c.y - (dy * o.width) / 2} x2={c.x + (dx * o.width) / 2} y2={c.y + (dy * o.width) / 2} stroke={o.confidence < 0.6 ? '#e37400' : colour} strokeWidth={w.thickness + 8} strokeOpacity={selected === o.id ? 0.85 : 0.5} strokeDasharray={o.confidence < 0.6 ? '6 4' : undefined} />
          </g>
        );
      })}
      {rooms.map((r) => (
        <g key={r.n} style={{ pointerEvents: 'none' }}>
          <circle cx={r.p.x} cy={r.p.y} r={16 * scale} fill="#1a73e8" />
          <text x={r.p.x} y={r.p.y + 5 * scale} fontSize={15 * scale} fill="#fff" textAnchor="middle" fontWeight={700}>
            {r.n}
          </text>
          <text x={r.p.x} y={r.p.y + 36 * scale} fontSize={13 * scale} fill="#1a3a6b" textAnchor="middle" fontWeight={500} stroke="#fff" strokeWidth={4 * scale} paintOrder="stroke">
            {r.name}
          </text>
        </g>
      ))}
      {measurePts.length === 2 && (
        <g style={{ pointerEvents: 'none' }}>
          <line x1={measurePts[0].x} y1={measurePts[0].y} x2={measurePts[1].x} y2={measurePts[1].y} stroke="#d93025" strokeWidth={3 * scale} />
          {measureLabel && (
            <text x={(measurePts[0].x + measurePts[1].x) / 2} y={(measurePts[0].y + measurePts[1].y) / 2 - 12 * scale} fontSize={16 * scale} fill="#d93025" textAnchor="middle" fontWeight={700} stroke="#fff" strokeWidth={5 * scale} paintOrder="stroke">
              {measureLabel}
            </text>
          )}
        </g>
      )}
      {measurePts.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={9 * scale}
          fill="#d93025"
          stroke="#fff"
          strokeWidth={3 * scale}
          style={{ cursor: 'grab' }}
          onPointerDown={(e) => {
            e.stopPropagation();
            dragging.current = i;
            moved.current = false;
            (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture?.(e.pointerId);
          }}
        />
      ))}
      {tracing && <circle cx={tracing.x} cy={tracing.y} r={6 * scale} fill="#1a73e8" />}
    </svg>
  );
}
