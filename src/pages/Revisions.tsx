import { useState } from 'react';
import { useStudio, roleLabel } from '../state/store';
import { Icon, PageHeader, timeAgo, IdTag, SourceChip, Spinner } from '../ui/common';
import { describeEdit, touchedIds } from '../model/edits';
import { Plan2D } from '../studio/Plan2D';
import { draftRationale } from '../ai/requests';
import { LocalModelUnavailable } from '../ai/hybrid';
import type { AISource } from '../model/types';
import { useIsMobile } from '../ui/hooks';

export function RevisionsPage() {
  const project = useStudio((s) => s.project);
  const replaceModel = useStudio((s) => s.replaceModel);
  const setBrief = useStudio((s) => s.setBrief);
  const toast = useStudio((s) => s.toast);
  const isMobile = useIsMobile();
  const revs = [...project.revisions].sort((a, b) => b.number - a.number);
  const [sel, setSel] = useState(revs[0]?.id);
  const [rationale, setRationale] = useState<{ text: string; source?: AISource; ms?: number; streaming: boolean } | null>(null);
  const rev = revs.find((r) => r.id === sel) ?? revs[0];
  const prev = rev ? project.revisions.find((r) => r.number === rev.number - 1) : undefined;
  const ids = new Set(rev ? rev.edits.flatMap(touchedIds) : []);
  const revTasks = rev ? project.tasks.filter((t) => t.links.revision === rev.number && t.origin === 'revision') : [];

  const write = async () => {
    setRationale({ text: '', streaming: true });
    try {
      const r = await draftRationale(project.model, project.brief, project.findings, project.revisions, (t) => setRationale({ text: t, streaming: true }));
      setRationale({ text: r.text, source: r.source, ms: r.latencyMs, streaming: false });
    } catch (e) {
      setRationale(null);
      toast(e instanceof LocalModelUnavailable ? e.message : (e as Error).message, 'error');
    }
  };

  return (
    <>
      <PageHeader title="Revisions" icon="history" subtitle="Every accepted change is a revision linking its edits, the findings it resolved and the drawing tasks it created." />
      <div className="page-inner">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <Icon name="edit_note" style={{ color: 'var(--blue)' }} />
            <h2>Design rationale</h2>
            <span className="sub hide-mobile">drafted from the model, revisions and fixed issues, written on your computer when it can</span>
            <div className="grow" />
            {rationale?.source && <SourceChip source={rationale.source} />}
            <button className="btn btn-tonal btn-sm" onClick={write} disabled={rationale?.streaming}>
              {rationale?.streaming ? <Spinner size={16} /> : <Icon name="auto_awesome" />} {rationale ? 'Redraft' : 'Draft rationale'}
            </button>
          </div>
          {rationale ? (
            <div className="card-body">
              <div className={rationale.streaming ? 'streaming-caret' : ''} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, maxWidth: 820 }}>
                {rationale.text}
              </div>
              {!rationale.streaming && (
                <div className="row wrap" style={{ marginTop: 12 }}>
                  <button className="btn btn-outline btn-sm" onClick={() => (navigator.clipboard?.writeText(rationale.text), toast('Rationale copied', 'success'))}>
                    <Icon name="content_copy" /> Copy
                  </button>
                  <button className="btn btn-text btn-sm" onClick={() => (setBrief({ notes: `${project.brief.notes}\n\nDesign rationale (rev ${project.model.revision}):\n${rationale.text}` }), toast('Added to the brief notes', 'success'))}>
                    <Icon name="note_add" /> Add to brief notes
                  </button>
                  {rationale.ms !== undefined && <span className="small faint">{rationale.ms} ms</span>}
                </div>
              )}
            </div>
          ) : (
            <div className="card-body small muted">Supports the rubric’s “design rationale” criterion: a first draft you edit, grounded only in what the model and review history show.</div>
          )}
        </div>

        <div className="grid stack-mobile" style={{ gridTemplateColumns: 'minmax(280px, 360px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
          <div className="card" style={{ overflow: 'hidden' }}>
            {revs.map((r) => {
              const n = project.tasks.filter((t) => t.links.revision === r.number && t.origin === 'revision').length;
              return (
                <div key={r.id} className={`finding ${r.id === rev?.id ? 'active' : ''}`} onClick={() => setSel(r.id)}>
                  <span className="sev info" style={{ fontWeight: 500 }}>
                    {r.number}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="title" style={{ fontSize: 14 }}>
                      {r.label}
                    </div>
                    <div className="small muted">
                      {r.author || 'ArchiMind'} · {roleLabel(r.role)} · {timeAgo(r.createdAt)}
                    </div>
                    <div className="row wrap small" style={{ gap: 4, marginTop: 4 }}>
                      {r.edits.length > 0 && <span className="chip">{r.edits.length} edit(s)</span>}
                      {r.findingIds.length > 0 && <span className="chip ok">{r.findingIds.length} finding(s)</span>}
                      {n > 0 && <span className="chip blue">{n} task(s)</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {rev && (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div className="card-header">
                <h2 style={{ minWidth: 0 }} className="text-ellipsis">
                  Revision {rev.number}: {rev.label}
                </h2>
                <div className="grow" />
                {rev.number !== project.model.revision && (
                  <button className="btn btn-outline btn-sm" onClick={() => replaceModel(rev.snapshot, `Restore revision ${rev.number}`)}>
                    <Icon name="restore" /> Restore as new revision
                  </button>
                )}
              </div>
              <div style={{ height: isMobile ? 260 : 360, position: 'relative', borderBottom: '1px solid var(--border-2)' }}>
                <Plan2D model={rev.snapshot} ghost={prev?.snapshot ?? null} previewIds={ids} editable={false} showUnderlay={false} highlight={ids} />
                {ids.size > 0 && (
                  <div className="pane-label">
                    <span className="chip">
                      <span className="dot" style={{ background: '#188038' }} /> changed
                      <span className="dot" style={{ background: '#d93025', marginLeft: 8 }} /> before
                    </span>
                  </div>
                )}
              </div>
              <div className="card-body grid grid-3" style={{ gap: 20 }}>
                <div>
                  <div className="label">Edits</div>
                  {rev.edits.length === 0 ? (
                    <div className="small muted">Baseline / import revision.</div>
                  ) : (
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {rev.edits.map((e, i) => (
                        <li key={i} style={{ marginBottom: 4 }}>
                          <code style={{ wordBreak: 'break-word' }}>{describeEdit(e, prev?.snapshot)}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <div className="label">Findings resolved</div>
                  {rev.findingIds.length === 0 ? (
                    <div className="small muted">None.</div>
                  ) : (
                    rev.findingIds.map((id) => {
                      const f = project.findings.find((x) => x.id === id);
                      return (
                        <div key={id} className="row small" style={{ padding: '4px 0', alignItems: 'flex-start' }}>
                          <Icon name="task_alt" size={16} style={{ color: 'var(--green)', marginTop: 1 }} />
                          <span>{f?.title ?? id}</span>
                        </div>
                      );
                    })
                  )}
                </div>
                <div>
                  <div className="label">Tasks created</div>
                  {revTasks.length === 0 ? (
                    <div className="small muted">None.</div>
                  ) : (
                    revTasks.map((t) => (
                      <div key={t.id} className="small" style={{ padding: '5px 0', borderBottom: '1px solid var(--border-2)' }}>
                        <div className="row" style={{ alignItems: 'flex-start', gap: 6 }}>
                          <Icon name={t.status === 'done' ? 'check_box' : 'check_box_outline_blank'} size={16} style={{ marginTop: 1 }} />
                          <span className="grow">{t.title}</span>
                        </div>
                        <div className="row wrap" style={{ gap: 4, marginTop: 4, paddingLeft: 22 }}>
                          {t.links.elementIds.slice(0, 3).map((id) => (
                            <IdTag key={id} id={id} />
                          ))}
                          <span className="faint">{t.effortHours} h</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
