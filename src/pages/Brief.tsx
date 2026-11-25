import { useState } from 'react';
import { useStudio } from '../state/store';
import { Icon, PageHeader, SourceChip, Spinner } from '../ui/common';
import { summarizeBrief, type BriefSummary } from '../ai/requests';
import { LocalModelUnavailable } from '../ai/hybrid';
import { ROOM_TYPES, type AISource, type DesignGoal, type RoomType } from '../model/types';
import { briefTasks } from '../model/sample';

const GOALS: DesignGoal[] = ['privacy', 'daylight', 'open-plan', 'accessibility', 'storage', 'flexibility'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function BriefPage() {
  const brief = useStudio((s) => s.project.brief);
  const setBrief = useStudio((s) => s.setBrief);
  const toast = useStudio((s) => s.toast);
  const tasks = useStudio((s) => s.project.tasks);
  const [summary, setSummary] = useState<{ data: BriefSummary; source: AISource; ms: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [rubricText, setRubricText] = useState('');

  const summarise = async () => {
    setBusy(true);
    try {
      const r = await summarizeBrief(brief);
      setSummary({ data: r.data, source: r.source, ms: r.latencyMs });
      setBrief({ summary: r.data.summary });
    } catch (e) {
      toast(e instanceof LocalModelUnavailable ? e.message : (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const regenerate = () => {
    const { tasks: t, milestones } = briefTasks(brief);
    useStudio.setState((s) => ({ project: { ...s.project, tasks: [...s.project.tasks.filter((x) => x.origin !== 'brief'), ...t], milestones } }));
    toast('Deliverable plan regenerated from the brief', 'success');
  };

  const importRubric = () => {
    // One criterion per line: "Name (weight%): description"
    const rows = rubricText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l, i) => {
        const m = l.match(/^(.+?)\s*\((\d+)%?\)\s*[:\-–]?\s*(.*)$/);
        return { id: `c${i + 1}`, name: (m?.[1] ?? l).trim(), weight: Number(m?.[2] ?? 0), description: (m?.[3] ?? '').trim() };
      });
    if (!rows.length) return;
    const total = rows.reduce((s, r) => s + r.weight, 0);
    const rubric = rows.map((r) => ({ ...r, weight: total ? r.weight : Math.round(100 / rows.length) }));
    setBrief({ rubric });
    setRubricText('');
    toast(`Rubric imported: ${rubric.length} criteria`, 'success');
  };

  return (
    <>
      <PageHeader
        title="Brief"
        icon="assignment"
        subtitle="Occupants, required spaces, goals and deadline. Requirements here drive the calculated review and the schedule."
        actions={
          <button className="btn btn-primary" onClick={summarise} disabled={busy}>
            {busy ? <Spinner /> : <Icon name="auto_awesome" />} Summarise on device
          </button>
        }
      />
      <div className="page-inner">
        {summary && (
          <div className="card card-pad" style={{ marginBottom: 16, borderColor: 'var(--blue-100)' }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <Icon name="auto_awesome" style={{ color: 'var(--blue)' }} />
              <b className="grow">Brief summary</b>
              <SourceChip source={summary.source} />
              <span className="small faint">{summary.ms} ms</span>
            </div>
            <div>{summary.data.summary}</div>
            <div className="grid grid-2" style={{ marginTop: 10 }}>
              <div>
                <div className="label">Priorities</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {summary.data.priorities.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="label">Risks</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {summary.data.risks.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        <div className="grid stack-mobile" style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)' }}>
          <div className="card">
            <div className="card-header">
              <h2>Project</h2>
            </div>
            <div className="card-body grid grid-2">
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Title</label>
                <input className="input" value={brief.title} onChange={(e) => setBrief({ title: e.target.value })} />
              </div>
              <div className="field">
                <label>Context</label>
                <div className="seg">
                  <button className={brief.mode === 'studio' ? 'on' : ''} onClick={() => setBrief({ mode: 'studio' })}>
                    <Icon name="school" /> Student studio
                  </button>
                  <button className={brief.mode === 'practice' ? 'on' : ''} onClick={() => setBrief({ mode: 'practice' })}>
                    <Icon name="business_center" /> Practice
                  </button>
                </div>
              </div>
              {brief.mode === 'practice' && (
                <div className="field">
                  <label>Client</label>
                  <input className="input" value={brief.client} onChange={(e) => setBrief({ client: e.target.value })} />
                </div>
              )}
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Occupants</label>
                <input className="input" value={brief.occupants} onChange={(e) => setBrief({ occupants: e.target.value })} />
              </div>
              <div className="field">
                <label>Site width (m)</label>
                <input className="input" type="number" value={brief.siteWidth} onChange={(e) => setBrief({ siteWidth: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>Site depth (m)</label>
                <input className="input" type="number" value={brief.siteDepth} onChange={(e) => setBrief({ siteDepth: Number(e.target.value) })} />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Design goals</label>
                <div className="row wrap">
                  {GOALS.map((g) => (
                    <button key={g} className={`chip chip-select ${brief.goals.includes(g) ? 'on' : ''}`} onClick={() => setBrief({ goals: brief.goals.includes(g) ? brief.goals.filter((x) => x !== g) : [...brief.goals, g] })}>
                      {brief.goals.includes(g) && <Icon name="check" />} {g}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Notes</label>
                <textarea className="textarea" value={brief.notes} onChange={(e) => setBrief({ notes: e.target.value })} />
              </div>
            </div>
          </div>

          <div className="col" style={{ gap: 16 }}>
            <div className="card">
              <div className="card-header">
                <h2>Time</h2>
              </div>
              <div className="card-body grid grid-2">
                <div className="field">
                  <label>Start</label>
                  <input className="input" type="date" value={brief.startDate} onChange={(e) => setBrief({ startDate: e.target.value })} />
                </div>
                <div className="field">
                  <label>Submission deadline</label>
                  <input className="input" type="date" value={brief.deadline} onChange={(e) => setBrief({ deadline: e.target.value })} />
                </div>
                <div className="field">
                  <label>Hours per working day</label>
                  <input className="input" type="number" min={0.5} step={0.5} value={brief.hoursPerDay} onChange={(e) => setBrief({ hoursPerDay: Number(e.target.value) })} />
                </div>
                <div className="field">
                  <label>Working days</label>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {DAYS.map((d, i) => (
                      <button key={d} className={`chip chip-select ${brief.workDays.includes(i) ? 'on' : ''}`} style={{ padding: '0 7px' }} onClick={() => setBrief({ workDays: brief.workDays.includes(i) ? brief.workDays.filter((x) => x !== i) : [...brief.workDays, i].sort() })}>
                        {d[0]}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ gridColumn: '1 / -1' }} className="row wrap">
                  <span className="small muted grow">{tasks.filter((t) => t.origin === 'brief').length} deliverable tasks from the brief</span>
                  <button className="btn btn-outline btn-sm" onClick={regenerate}>
                    <Icon name="autorenew" /> Regenerate deliverables
                  </button>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h2>{brief.mode === 'studio' ? 'Lecturer’s rubric' : 'Review criteria'}</h2>
              </div>
              <div className="card-body">
                {brief.rubric.map((c) => (
                  <div key={c.id} className="row" style={{ padding: '4px 0' }}>
                    <span className="grow">{c.name}</span>
                    <span className="chip">{c.weight}%</span>
                  </div>
                ))}
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Paste a rubric, one criterion per line, e.g. “Concept (20%): a clear idea…”</label>
                  <textarea className="textarea" value={rubricText} onChange={(e) => setRubricText(e.target.value)} style={{ minHeight: 70 }} />
                </div>
                <button className="btn btn-outline btn-sm" style={{ marginTop: 8 }} onClick={importRubric} disabled={!rubricText.trim()}>
                  <Icon name="upload" /> Use this rubric
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h2>Required spaces</h2>
            <span className="sub">checked continuously against the model</span>
            <div className="grow" />
            <button className="btn btn-outline btn-sm" onClick={() => setBrief({ requirements: [...brief.requirements, { id: `q${Date.now()}`, type: 'other', label: 'New space', count: 1, minArea: 6 }] })}>
              <Icon name="add" /> Add space
            </button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Space</th>
                <th>Type</th>
                <th>Count</th>
                <th>Min. net area (m²)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {brief.requirements.map((q, i) => {
                const upd = (patch: Partial<typeof q>) => setBrief({ requirements: brief.requirements.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <tr key={q.id}>
                    <td>
                      <input className="input input-sm" value={q.label} onChange={(e) => upd({ label: e.target.value })} />
                    </td>
                    <td>
                      <select className="select input-sm" value={q.type} onChange={(e) => upd({ type: e.target.value as RoomType })}>
                        {ROOM_TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ width: 100 }}>
                      <input className="input input-sm" type="number" min={1} value={q.count} onChange={(e) => upd({ count: Number(e.target.value) })} />
                    </td>
                    <td style={{ width: 160 }}>
                      <input className="input input-sm" type="number" min={0} step={0.5} value={q.minArea} onChange={(e) => upd({ minArea: Number(e.target.value) })} />
                    </td>
                    <td style={{ width: 50 }}>
                      <button className="icon-btn" onClick={() => setBrief({ requirements: brief.requirements.filter((_, j) => j !== i) })} aria-label="Remove">
                        <Icon name="delete" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
