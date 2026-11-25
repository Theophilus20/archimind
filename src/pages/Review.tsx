import { useEffect, useMemo, useState } from 'react';
import { useStudio, newTaskId } from '../state/store';
import { useRoute, navigate } from '../ui/router';
import { Icon, IdTag, PageHeader, SourceChip, Spinner } from '../ui/common';
import { Plan2D } from '../studio/Plan2D';
import { interpretiveReview, type InterpretiveReview } from '../ai/requests';
import { findingId } from '../review/rules';
import { describeEdit } from '../model/edits';
import type { AISource, Finding, FindingSeverity } from '../model/types';
import { LocalModelUnavailable } from '../ai/hybrid';
import { useDevMode } from '../ui/hooks';

type Tab = 'calculated' | 'interpretive' | 'rubric' | 'closed';

const SEV_ICON: Record<FindingSeverity, string> = { critical: 'report', warning: 'warning', advice: 'lightbulb', info: 'info' };

export function ReviewPage() {
  const { params } = useRoute();
  const project = useStudio((s) => s.project);
  const addFindings = useStudio((s) => s.addFindings);
  const setStatus = useStudio((s) => s.setFindingStatus);
  const startPreview = useStudio((s) => s.startPreview);
  const addTasks = useStudio((s) => s.addTasks);
  const toast = useStudio((s) => s.toast);
  const focusOn = useStudio((s) => s.focusOn);
  const [tab, setTab] = useState<Tab>('calculated');
  const [busy, setBusy] = useState(false);
  const [rubric, setRubric] = useState<{ data: InterpretiveReview; source: AISource; ms: number } | null>(() => {
    try {
      return JSON.parse(sessionStorage.getItem('archimind.rubric') ?? 'null');
    } catch {
      return null;
    }
  });
  const [activeId, setActiveId] = useState<string | null>(params.get('finding'));
  const [mobileDetail, setMobileDetail] = useState(Boolean(params.get('finding')));

  const list = useMemo(() => {
    const f = project.findings;
    if (tab === 'calculated') return f.filter((x) => x.kind === 'calculated' && (x.status === 'open' || x.status === 'outdated'));
    if (tab === 'interpretive') return f.filter((x) => x.kind === 'interpretive' && (x.status === 'open' || x.status === 'outdated'));
    if (tab === 'closed') return f.filter((x) => x.status === 'resolved' || x.status === 'dismissed');
    return [];
  }, [project.findings, tab]);

  const active = project.findings.find((f) => f.id === activeId) ?? list[0];

  const runReview = async () => {
    setBusy(true);
    try {
      const r = await interpretiveReview(project.model, project.brief, project.findings, { revisions: project.revisions });
      const now = Date.now();
      const src = r.source === 'on_device' ? 'ai-on-device' : r.source === 'in_cloud' ? 'ai-cloud' : 'heuristic';
      const fs: Finding[] = r.data.findings.map((f) => ({
        id: findingId(),
        fingerprint: `ai:${f.title}`,
        source: src,
        kind: 'interpretive',
        severity: 'advice',
        category: f.category,
        title: f.title,
        finding: f.finding,
        evidence: { elementIds: f.elementIds, text: 'A design suggestion based on judgement rather than measurement.', overlays: [] },
        suggestion: f.suggestion,
        revision: project.model.revision,
        status: 'open',
        createdAt: now,
      }));
      addFindings(fs);
      const val = { data: r.data, source: r.source, ms: r.latencyMs };
      setRubric(val);
      try {
        sessionStorage.setItem('archimind.rubric', JSON.stringify(val));
      } catch {
        /* ignore */
      }
      setTab(fs.length ? 'interpretive' : 'rubric');
      toast(`Review ready: ${fs.length} design suggestion${fs.length === 1 ? '' : 's'}`, 'success');
    } catch (e) {
      toast(e instanceof LocalModelUnavailable ? e.message : (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const preview = (f: Finding) => {
    if (!f.proposal) return;
    if (startPreview(f.proposal, { findingId: f.id })) navigate('studio');
  };

  const addTask = (f: Finding) => {
    addTasks([
      {
        id: newTaskId(),
        title: `Resolve: ${f.title}`,
        owner: project.brief.mode === 'studio' ? 'Student' : 'Architect',
        effortHours: f.severity === 'critical' ? 4 : 2,
        deps: [],
        status: 'todo',
        origin: 'finding',
        links: { elementIds: f.evidence.elementIds, findingIds: [f.id], revision: project.model.revision },
        deliverable: 'Floor plan',
        createdAt: Date.now(),
      },
    ]);
    toast('Task added to the schedule', 'success');
  };

  const counts = {
    calculated: project.findings.filter((x) => x.kind === 'calculated' && x.status === 'open').length,
    interpretive: project.findings.filter((x) => x.kind === 'interpretive' && x.status === 'open').length,
    closed: project.findings.filter((x) => x.status === 'resolved' || x.status === 'dismissed').length,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title="Design review"
        icon="rule"
        subtitle="ArchiMind checks your plan against the brief and good design practice. Measured issues come straight from your drawing; design suggestions come from AI and are a matter of opinion."
        actions={
          <button className="btn btn-primary" onClick={runReview} disabled={busy}>
            {busy ? <Spinner /> : <Icon name="auto_awesome" />} Get AI design feedback
          </button>
        }
        tabs={
          <>
            {(
              [
                ['calculated', 'straighten', `Measured issues (${counts.calculated})`],
                ['interpretive', 'psychology', `Design suggestions (${counts.interpretive})`],
                ['rubric', 'school', project.brief.mode === 'studio' ? 'Rubric feedback' : 'Criteria'],
                ['closed', 'task_alt', `Fixed or dismissed (${counts.closed})`],
              ] as [Tab, string, string][]
            ).map(([t, icon, label]) => (
              <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
                <Icon name={icon} /> {label}
              </button>
            ))}
          </>
        }
      />
      {tab === 'rubric' ? (
        <div className="page-inner" style={{ width: '100%' }}>
          <RubricView rubric={rubric} onRun={runReview} busy={busy} />
        </div>
      ) : (
        <div className="review-split" data-detail={String(mobileDetail)} style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) minmax(0, 1fr)', minHeight: 0 }}>
          <div style={{ overflowY: 'auto', background: 'var(--surface)', borderRight: '1px solid var(--border)' }}>
            {list.length === 0 && (
              <div className="empty">
                <Icon name={tab === 'interpretive' ? 'psychology' : 'verified'} />
                {tab === 'interpretive' ? 'Press Get AI design feedback for suggestions on concept, flow and presentation.' : tab === 'closed' ? 'Nothing fixed yet.' : 'No measured issues. Nice work.'}
              </div>
            )}
            {list.map((f) => (
              <div key={f.id} className={`finding ${active?.id === f.id ? 'active' : ''} ${f.status !== 'open' ? 'dim' : ''}`} onClick={() => (setActiveId(f.id), setMobileDetail(true))}>
                <span className={`sev ${f.severity}`}>
                  <Icon name={SEV_ICON[f.severity]} size={18} />
                </span>
                <div>
                  <div className="title">{f.title}</div>
                  <div className="row wrap small" style={{ gap: 6, marginTop: 4 }}>
                    <span className="chip">{f.category}</span>
                    {f.status === 'outdated' && <span className="chip warn">plan changed since</span>}
                    {f.status === 'resolved' && <span className="chip ok">fixed</span>}
                    {f.status === 'dismissed' && <span className="chip">dismissed</span>}
                    {f.proposal && f.status === 'open' && (
                      <span className="chip blue">
                        <Icon name="auto_fix_high" /> fix ready
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ overflowY: 'auto', padding: 24 }}>
            <button className="btn btn-text mobile-back" onClick={() => setMobileDetail(false)} style={{ marginBottom: 8 }}>
              <Icon name="arrow_back" /> All findings
            </button>
            {active ? (
              <FindingDetail f={active} onPreview={preview} onTask={addTask} onDismiss={(f) => setStatus(f.id, 'dismissed')} onReopen={(f) => setStatus(f.id, 'open')} onFocus={(ids) => focusOn(ids)} />
            ) : (
              <div className="empty">Select a finding.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FindingDetail({ f, onPreview, onTask, onDismiss, onReopen, onFocus }: { f: Finding; onPreview: (f: Finding) => void; onTask: (f: Finding) => void; onDismiss: (f: Finding) => void; onReopen: (f: Finding) => void; onFocus: (ids: string[]) => void }) {
  const model = useStudio((s) => s.project.model);
  const focus = useStudio((s) => s.focusOn);
  const dev = useDevMode((d) => d.on);
  const highlight = useMemo(() => new Set(f.evidence.elementIds), [f]);
  return (
    <div className="card" style={{ maxWidth: 980 }}>
      <div className="card-header" style={{ alignItems: 'flex-start' }}>
        <span className={`sev ${f.severity}`} style={{ width: 36, height: 36 }}>
          <Icon name={SEV_ICON[f.severity]} />
        </span>
        <div className="grow">
          <h2 style={{ fontSize: 18 }}>{f.title}</h2>
          <div className="row wrap small muted" style={{ gap: 6, marginTop: 4 }}>
            <span className={`chip ${f.kind === 'calculated' ? 'teal' : 'purple'}`}>
              <Icon name={f.kind === 'calculated' ? 'straighten' : 'psychology'} /> {f.kind === 'calculated' ? 'Measured from your plan' : 'Design suggestion'}
            </span>
            {f.source !== 'rule' && f.source !== 'person' && <SourceChip source={f.source === 'ai-on-device' ? 'on_device' : f.source === 'ai-cloud' ? 'in_cloud' : 'heuristic'} />}
            {dev && f.ruleId && <code>{f.ruleId}</code>}
            {dev && <span>version {f.revision}</span>}
          </div>
        </div>
      </div>
      <div className="card-body">
        <div className="grid stack-mobile" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 20 }}>
          <div className="col" style={{ gap: 14 }}>
            <div>
              <div className="label">Finding</div>
              <div>{f.finding}</div>
            </div>
            <div>
              <div className="label">Evidence</div>
              <div className="finding" style={{ padding: 0, display: 'block', cursor: 'default', border: 0 }}>
                <div className="ev">{f.evidence.text}</div>
              </div>
              <div className="row wrap" style={{ gap: 4, marginTop: 8 }}>
                {f.evidence.elementIds.map((id) => (
                  <IdTag key={id} id={id} />
                ))}
              </div>
            </div>
            <div>
              <div className="label">Suggestion</div>
              <div>{f.suggestion}</div>
            </div>
            {f.proposal && (
              <div className="card" style={{ background: 'var(--blue-50)', border: 0 }}>
                <div className="card-body" style={{ padding: 12 }}>
                  <div className="row small" style={{ fontWeight: 500, color: 'var(--on-tonal)' }}>
                    <Icon name="auto_fix_high" /> Suggested fix (checked against your plan)
                  </div>
                  <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {f.proposal.edits.map((e, i) => (
                      <li key={i}>
                        <code>{describeEdit(e, model)}</code>
                      </li>
                    ))}
                  </ul>
                  {f.proposal.rationale && <div className="small muted" style={{ marginTop: 6 }}>{f.proposal.rationale}</div>}
                </div>
              </div>
            )}
            <div className="row wrap">
              {f.status === 'open' ? (
                <>
                  {f.proposal && (
                    <button className="btn btn-primary" onClick={() => onPreview(f)}>
                      <Icon name="preview" /> Preview change
                    </button>
                  )}
                  <button className="btn btn-outline" onClick={() => onTask(f)}>
                    <Icon name="add_task" /> Add task
                  </button>
                  <button
                    className="btn btn-outline"
                    onClick={() => {
                      focus(f.evidence.elementIds);
                      navigate('crit', { finding: f.id });
                    }}
                  >
                    <Icon name="forum" /> Discuss
                  </button>
                  <button className="btn btn-text" onClick={() => onDismiss(f)}>
                    Dismiss
                  </button>
                </>
              ) : (
                <button className="btn btn-outline" onClick={() => onReopen(f)}>
                  <Icon name="undo" /> Reopen
                </button>
              )}
              <button className="btn btn-text" onClick={() => { onFocus(f.evidence.elementIds); navigate('studio'); }}>
                <Icon name="view_in_ar" /> Show in 3D
              </button>
            </div>
          </div>
          <div style={{ height: 360, minHeight: 260, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
            <PlanFocus ids={f.evidence.elementIds} overlays={f.evidence.overlays} highlight={highlight} />
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanFocus({ ids, overlays, highlight }: { ids: string[]; overlays: Finding['evidence']['overlays']; highlight: Set<string> }) {
  const model = useStudio((s) => s.project.model);
  const focusOn = useStudio((s) => s.focusOn);
  const key = ids.join(',');
  // Re-focus the plan when the finding changes.
  useEffect(() => {
    const t = setTimeout(() => ids.length && focusOn(ids), 30);
    return () => clearTimeout(t);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Plan2D model={model} overlays={overlays} editable={false} showUnderlay={false} highlight={highlight} />;
}

function RubricView({ rubric, onRun, busy }: { rubric: { data: InterpretiveReview; source: AISource; ms: number } | null; onRun: () => void; busy: boolean }) {
  const brief = useStudio((s) => s.project.brief);
  if (!rubric)
    return (
      <div className="card empty">
        <Icon name="school" />
        <div style={{ marginBottom: 12 }}>Early feedback against {brief.rubric.length ? 'your lecturer’s rubric' : 'your criteria'}. Your lecturer gives the final grade.</div>
        <button className="btn btn-primary" onClick={onRun} disabled={busy}>
          {busy ? <Spinner /> : <Icon name="auto_awesome" />} Get AI design feedback
        </button>
      </div>
    );
  const weighted = rubric.data.criteria.reduce((s, c) => s + c.score * ((brief.rubric.find((r) => r.id === c.criterionId)?.weight ?? 0) / 100), 0);
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card card-pad">
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <div>
            <div className="label">Early score</div>
            <div style={{ fontSize: 40, lineHeight: '48px' }}>{Math.round(weighted)}</div>
            <div className="small muted">not a grade, your lecturer decides</div>
          </div>
          <div className="grow">
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="label grow">Overall</span>
              <SourceChip source={rubric.source} />
              <span className="small faint">{rubric.ms} ms</span>
            </div>
            <div>{rubric.data.overall}</div>
          </div>
        </div>
      </div>
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Weight</th>
              <th>Provisional</th>
              <th>Strengths</th>
              <th>To improve</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {rubric.data.criteria.map((c) => {
              const r = brief.rubric.find((x) => x.id === c.criterionId);
              return (
                <tr key={c.criterionId}>
                  <td style={{ fontWeight: 500 }}>{r?.name ?? c.criterionId}</td>
                  <td>{r?.weight ?? 0}%</td>
                  <td style={{ width: 140 }}>
                    <div className="row">
                      <span style={{ width: 28 }}>{c.score}</span>
                      <div className="meter grow">
                        <span style={{ width: `${c.score}%`, background: c.score >= 70 ? 'var(--green)' : c.score >= 55 ? 'var(--fb-amber)' : 'var(--red)' }} />
                      </div>
                    </div>
                  </td>
                  <td className="small">{c.strengths}</td>
                  <td className="small">{c.improvement}</td>
                  <td className="small" style={{ minWidth: 200 }}>
                    {c.evidence && <div className="muted">{c.evidence}</div>}
                    {c.elementIds.length > 0 && (
                      <div className="row wrap" style={{ gap: 4, marginTop: c.evidence ? 6 : 0 }}>
                        {c.elementIds.map((id) => (
                          <IdTag key={id} id={id} />
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
