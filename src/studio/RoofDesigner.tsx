import { useEffect, useState } from 'react';
import { useStudio } from '../state/store';
import { normalizeRoof } from '../model/edits';
import { roofShape, ROOF_LABEL } from '../model/roof';
import { roofMaterials } from '../model/materials';
import { suggestRoof } from '../ai/roof';
import { LocalModelUnavailable } from '../ai/hybrid';
import { Icon, SourceChip, Spinner, Switch } from '../ui/common';
import type { AISource, RoofDesign } from '../model/types';

const KINDS: RoofDesign['kind'][] = ['none', 'flat', 'shed', 'gable', 'hip'];

function KindIcon({ kind }: { kind: RoofDesign['kind'] }) {
  const p: Record<RoofDesign['kind'], string> = {
    none: 'M4 22h24M8 22V14h16v8',
    flat: 'M3 12h26v3H3zM8 15v7h16v-7',
    shed: 'M3 15 29 8v4L3 18zM8 17v5h16v-9',
    gable: 'M3 15 16 6l13 9M8 13v9h16v-9',
    hip: 'M3 15 10 8h12l7 7M8 15v7h16v-7',
  };
  return (
    <svg width="32" height="26" viewBox="0 0 32 26" aria-hidden>
      <path d={p[kind]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** Roof design panel: type, pitch, overhang, ridge direction and material, plus an AI suggestion. */
export function RoofDesigner({ visible, onVisible, onClose }: { visible: boolean; onVisible: (v: boolean) => void; onClose: () => void }) {
  const model = useStudio((s) => s.project.model);
  const brief = useStudio((s) => s.project.brief);
  const edit = useStudio((s) => s.edit);
  const toast = useStudio((s) => s.toast);
  const roof = normalizeRoof(model.roof);
  const [pitch, setPitch] = useState(roof.pitch);
  const [overhang, setOverhang] = useState(roof.overhang);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<{ text: string; source: AISource } | null>(null);
  useEffect(() => {
    setPitch(roof.pitch);
    setOverhang(roof.overhang);
  }, [roof.pitch, roof.overhang]);
  const shape = roofShape(model);
  const set = (patch: Partial<Omit<RoofDesign, 'prov'>>, label = 'Update roof') => {
    edit([{ op: 'setRoof', patch }], label);
    if (patch.kind && patch.kind !== 'none') onVisible(true);
  };
  const pitched = roof.kind === 'shed' || roof.kind === 'gable' || roof.kind === 'hip';

  const suggest = async () => {
    setBusy(true);
    try {
      const r = await suggestRoof(model, brief);
      set({ kind: r.data.kind, pitch: r.data.pitch, overhang: r.data.overhang, materialId: r.data.materialId }, 'AI roof suggestion');
      setWhy({ text: r.data.reason, source: r.source });
    } catch (e) {
      toast(e instanceof LocalModelUnavailable ? e.message : (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card roof-panel" role="dialog" aria-label="Roof designer">
      <div className="card-header" style={{ padding: '10px 14px' }}>
        <Icon name="roofing" style={{ color: 'var(--fb-orange)' }} />
        <b className="grow">Roof designer</b>
        <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={onClose} aria-label="Close roof designer">
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="card-body col" style={{ gap: 12, padding: '12px 14px' }}>
        <div className="roof-kinds">
          {KINDS.map((k) => (
            <button key={k} className={roof.kind === k ? 'on' : ''} onClick={() => set({ kind: k }, `Roof: ${ROOF_LABEL[k].toLowerCase()}`)}>
              <KindIcon kind={k} />
              <span>{ROOF_LABEL[k]}</span>
            </button>
          ))}
        </div>
        {roof.kind !== 'none' && (
          <>
            <label className="field">
              <span className="label row">
                <span className="grow">Pitch</span>
                <span>{pitched ? `${pitch}°` : 'flat'}</span>
              </span>
              <input type="range" min={5} max={55} step={1} value={pitch} disabled={!pitched} onChange={(e) => setPitch(Number(e.target.value))} onPointerUp={() => pitch !== roof.pitch && set({ pitch })} onKeyUp={() => pitch !== roof.pitch && set({ pitch })} />
            </label>
            <label className="field">
              <span className="label row">
                <span className="grow">Overhang</span>
                <span>{overhang} mm</span>
              </span>
              <input type="range" min={0} max={1000} step={50} value={overhang} onChange={(e) => setOverhang(Number(e.target.value))} onPointerUp={() => overhang !== roof.overhang && set({ overhang })} onKeyUp={() => overhang !== roof.overhang && set({ overhang })} />
            </label>
            {pitched && (
              <div className="field">
                <span className="label">Ridge direction</span>
                <div className="seg">
                  {(
                    [
                      ['auto', 'Automatic'],
                      ['x', 'Left to right'],
                      ['y', 'Front to back'],
                    ] as const
                  ).map(([r, label]) => (
                    <button key={r} className={roof.ridge === r ? 'on' : ''} onClick={() => set({ ridge: r })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="field">
              <span className="label">Material</span>
              <div className="row wrap" style={{ gap: 6 }}>
                {roofMaterials.map((m) => (
                  <button key={m.id} className={`chip chip-select ${roof.materialId === m.id ? 'on' : ''}`} onClick={() => set({ materialId: m.id })} title={m.name}>
                    <span className="dot" style={{ background: m.color, width: 12, height: 12 }} /> {m.name}
                  </button>
                ))}
              </div>
            </div>
            {shape && <div className="small muted">Ridge height about {(shape.peak / 1000).toFixed(1)} m above the floor.</div>}
            <div className="row">
              <Switch on={visible} onChange={onVisible} label="Show roof in 3D" />
              <span className="small">Show roof in 3D</span>
            </div>
          </>
        )}
        <div className="divider" style={{ margin: 0 }} />
        <button className="btn btn-tonal btn-sm" onClick={suggest} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? <Spinner size={16} /> : <Icon name="auto_awesome" />} Suggest a roof for this brief
        </button>
        {why && (
          <div className="small" style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '8px 10px' }}>
            <div className="row" style={{ marginBottom: 4 }}>
              <b className="grow">Why this roof</b>
              <SourceChip source={why.source} compact />
            </div>
            {why.text}
          </div>
        )}
        <div className="small faint">A floor plan doesn't show the roof, so it stays a design choice you can change any time.</div>
      </div>
    </div>
  );
}
