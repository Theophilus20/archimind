import { useEffect, useMemo, useRef, useState } from 'react';
import { useStudio, newTaskId } from '../state/store';
import { schedule, type ScheduledTask } from '../schedule/scheduler';
import { Icon, IdTag, PageHeader, fmtDate } from '../ui/common';
import type { Task, TaskStatus } from '../model/types';
import { TaskDialog } from './TaskDialog';
import { draftTaskDetails } from '../schedule/details';

const ORIGIN: Record<Task['origin'], { label: string; cls: string; icon: string }> = {
  brief: { label: 'brief', cls: '', icon: 'assignment' },
  finding: { label: 'finding', cls: 'warn', icon: 'flag' },
  revision: { label: 'revision', cls: 'ok', icon: 'history' },
  message: { label: 'crit', cls: 'purple', icon: 'forum' },
  manual: { label: 'manual', cls: '', icon: 'edit' },
  ai: { label: 'AI draft', cls: 'blue', icon: 'auto_awesome' },
};

export function SchedulePage() {
  const project = useStudio((s) => s.project);
  const updateTask = useStudio((s) => s.updateTask);
  const removeTask = useStudio((s) => s.removeTask);
  const addTasks = useStudio((s) => s.addTasks);
  const [newTitle, setNewTitle] = useState('');
  /** The task open in the details dialog ('new' while adding one with details). */
  const [openTask, setOpenTask] = useState<string | null>(null);
  const quickAdd = () => {
    const title = newTitle.trim();
    if (!title) return;
    addTasks([{ id: newTaskId(), title, owner: project.brief.mode === 'studio' ? 'Student' : 'Architect', effortHours: 2, deps: [], status: 'todo', origin: 'manual', links: { elementIds: [], findingIds: [] }, createdAt: Date.now() }]);
    setNewTitle('');
  };
  const result = useMemo(() => schedule(project.tasks, project.brief), [project.tasks, project.brief]);
  const { brief } = project;

  return (
    <>
      <PageHeader
        title="Schedule"
        icon="event_note"
        subtitle="AI and reviews draft tasks; dates, dependencies and lateness are calculated deterministically from your available hours."
      />
      <div className="page-inner">
        <div className="grid grid-4">
          <div className="card stat">
            <div className="k">Projected finish</div>
            <div className="v" style={{ color: result.overrunDays ? 'var(--red)' : undefined }}>
              {fmtDate(result.projectedFinish)}
            </div>
            <div className="d">deadline {fmtDate(brief.deadline)}</div>
          </div>
          <div className="card stat">
            <div className="k">Remaining work</div>
            <div className="v">{result.remainingHours} h</div>
            <div className="d">{result.availableHours} h available before deadline</div>
          </div>
          <div className="card stat">
            <div className="k">Status</div>
            <div className="v">{result.overrunDays ? `${result.overrunDays} d late` : 'On track'}</div>
            <div className="d">{result.items.filter((i) => i.critical).length} tasks on the critical chain</div>
          </div>
          <div className="card stat">
            <div className="k">Capacity</div>
            <div className="v">{brief.hoursPerDay} h/day</div>
            <div className="d">{brief.workDays.map((d) => 'SMTWTFS'[d]).join(' ')}</div>
          </div>
        </div>

        {result.cycle && (
          <div className="card card-pad" style={{ marginTop: 16, borderColor: 'var(--red)', color: 'var(--red)' }}>
            <Icon name="error" /> Dependency cycle between {result.cycle.join(', ')}, so these tasks can’t be scheduled.
          </div>
        )}

        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h2>Timeline</h2>
            <span className="sub">Milestones: {project.milestones.map((m) => `${m.name} ${fmtDate(m.date)}`).join(' · ')}</span>
          </div>
          <Gantt items={result.items} workdays={result.workdays} deadline={brief.deadline} milestones={project.milestones} onOpen={setOpenTask} />
        </div>

        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-header">
            <h2>Tasks</h2>
            <div className="grow" />
            <div className="new-task">
              <input className="input input-sm" placeholder="New task…" aria-label="New task" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && quickAdd()} />
              <button className="btn btn-outline btn-sm" onClick={() => setOpenTask('new')} title="Add a task with details, notes, effort, due date and who does it">
                <Icon name="edit_note" /> Details
              </button>
              <button className="btn btn-primary btn-sm" onClick={quickAdd} disabled={!newTitle.trim()}>
                <Icon name="add" /> Add
              </button>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Source</th>
                <th>Owner</th>
                <th>Effort</th>
                <th>Scheduled</th>
                <th>Due</th>
                <th>Links</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {result.items.map((it) => {
                const t = it.task;
                const o = ORIGIN[t.origin];
                return (
                  <tr key={t.id} style={{ opacity: t.status === 'done' ? 0.55 : 1 }}>
                    <td style={{ maxWidth: 340 }}>
                      <button className="task-open" onClick={() => setOpenTask(t.id)} title="Open the task details">
                        {t.title}
                      </button>
                      {(t.notes || draftTaskDetails(t, project)) && <div className="task-preview">{(t.notes || draftTaskDetails(t, project)).replace(/\n•\s*/g, ' · ').replace(/\n/g, ' ')}</div>}
                      <div className="small muted">
                        {t.deliverable ?? ''}
                        {t.deps.length ? ` · after ${t.deps.filter((d) => project.tasks.some((x) => x.id === d)).length} task(s)` : ''}
                      </div>
                    </td>
                    <td>
                      <span className={`chip ${o.cls}`}>
                        <Icon name={o.icon} /> {o.label}
                      </span>
                    </td>
                    <td>{t.owner}</td>
                    <td style={{ width: 90 }}>
                      <input className="input input-sm" type="number" min={0.25} step={0.5} value={t.effortHours} onChange={(e) => updateTask(t.id, { effortHours: Number(e.target.value) })} style={{ width: 70 }} />
                    </td>
                    <td className="small">
                      {fmtDate(it.start)} → {fmtDate(it.end)}
                    </td>
                    <td className="small">
                      {it.late ? <span className="chip error">late · {fmtDate(it.due)}</span> : it.critical ? <span className="chip warn">{fmtDate(it.due)} · critical</span> : fmtDate(it.due)}
                    </td>
                    <td>
                      <div className="row wrap" style={{ gap: 3 }}>
                        {t.links.elementIds.slice(0, 3).map((id) => (
                          <IdTag key={id} id={id} />
                        ))}
                        {t.links.revision && t.origin === 'revision' && <span className="chip">rev {t.links.revision}</span>}
                      </div>
                    </td>
                    <td>
                      <select className="select input-sm" value={t.status} onChange={(e) => updateTask(t.id, { status: e.target.value as TaskStatus })} style={{ width: 100 }}>
                        <option value="todo">To do</option>
                        <option value="doing">Doing</option>
                        <option value="done">Done</option>
                      </select>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="icon-btn" onClick={() => setOpenTask(t.id)} aria-label="Open task details" title="Details">
                        <Icon name="open_in_full" />
                      </button>
                      <button className="icon-btn" onClick={() => removeTask(t.id)} aria-label="Delete task" title="Delete">
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
      {openTask && (
        <TaskDialog
          key={openTask === 'new' ? `new-${newTitle}` : openTask}
          task={openTask === 'new' ? undefined : project.tasks.find((t) => t.id === openTask)}
          scheduled={result.items.find((i) => i.task.id === openTask)}
          initialTitle={openTask === 'new' ? newTitle.trim() : ''}
          onClose={() => {
            if (openTask === 'new') setNewTitle('');
            setOpenTask(null);
          }}
        />
      )}
    </>
  );
}

function Gantt({ items, workdays, deadline, milestones, onOpen }: { items: ScheduledTask[]; workdays: string[]; deadline: string; milestones: { name: string; date: string }[]; onOpen: (id: string) => void }) {
  const lastDay = items.reduce((m, i) => (i.end > m ? i.end : m), deadline);
  const days = workdays.filter((d) => d <= lastDay || d <= deadline).slice(0, 80);
  // Fit the card: narrower day columns on a narrower window (it scrolls only below 16 px a day).
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(1100);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setAvail(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const left = Math.max(150, Math.min(260, Math.round(avail * 0.26)));
  const tail = 64; // room for the Deadline and milestone labels after the last day
  const col = Math.max(16, Math.min(34, Math.floor((avail - left - tail) / Math.max(1, days.length))));
  const row = 30;
  const chars = Math.floor((left - 24) / 6.8); // task names cut to fit the label column
  const W = left + days.length * col + tail;
  const H = 44 + items.length * row + 10;
  const x = (iso: string) => {
    const i = days.findIndex((d) => d >= iso);
    return left + (i === -1 ? days.length : i) * col;
  };
  const deadlineX = left + (days.filter((d) => d <= deadline).length) * col;
  return (
    <div className="gantt" ref={box}>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {days.map((d, i) => {
          const dt = new Date(d + 'T00:00:00');
          const monday = dt.getDay() === 1;
          return (
            <g key={d}>
              <rect x={left + i * col} y={40} width={col} height={H - 40} style={{ fill: i % 2 ? 'var(--gantt-b)' : 'var(--gantt-a)' }} />
              {monday && <line x1={left + i * col} y1={30} x2={left + i * col} y2={H} style={{ stroke: 'var(--gantt-line)' }} />}
              <text x={left + i * col + col / 2} y={18} fontSize={10} style={{ fill: 'var(--text-3)' }} textAnchor="middle">
                {dt.toLocaleDateString('en-GB', { weekday: 'narrow' })}
              </text>
              <text x={left + i * col + col / 2} y={32} fontSize={11} style={{ fill: 'var(--text-2)' }} textAnchor="middle">
                {dt.getDate()}
              </text>
            </g>
          );
        })}
        {items.map((it, i) => {
          const y = 44 + i * row;
          const x0 = x(it.start);
          const x1 = Math.max(x0 + 8, x(it.end) + col);
          const fill = it.task.status === 'done' ? '#bdc1c6' : it.late ? '#d93025' : it.critical ? '#f9ab00' : it.task.origin === 'revision' ? '#1e8e3e' : it.task.origin === 'message' ? '#8430ce' : '#1a73e8';
          return (
            <g key={it.task.id} className="gantt-row" role="button" tabIndex={0} aria-label={`Open ${it.task.title}`} onClick={() => onOpen(it.task.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onOpen(it.task.id)}>
              <title>{`${it.task.title}: ${it.task.effortHours} h, ${fmtDate(it.start)} to ${fmtDate(it.end)}. Click for details.`}</title>
              <rect className="gantt-hit" x={0} y={y + 2} width={W} height={row - 4} rx={4} />
              <text x={12} y={y + 18} fontSize={12} style={{ fill: 'var(--gantt-text)' }}>
                {it.task.title.length > chars ? it.task.title.slice(0, chars - 1) + '…' : it.task.title}
              </text>
              <rect x={x0 + 2} y={y + 6} width={x1 - x0 - 4} height={row - 12} rx={4} fill={fill} opacity={0.9} />
              <text x={x0 + 8} y={y + 19} fontSize={10.5} fill="#fff">
                {it.task.effortHours} h
              </text>
            </g>
          );
        })}
        <line x1={deadlineX} y1={34} x2={deadlineX} y2={H} stroke="#d93025" strokeWidth={2} strokeDasharray="4 3" />
        <text x={deadlineX + 4} y={H - 6} fontSize={11} fill="#d93025">
          Deadline
        </text>
        {milestones
          .filter((m) => m.date !== deadline)
          .map((m) => {
            const mx = left + days.filter((d) => d <= m.date).length * col;
            return (
              <g key={m.name}>
                <line x1={mx} y1={34} x2={mx} y2={H} stroke="#e37400" strokeWidth={1.5} strokeDasharray="3 3" />
                <text x={mx + 4} y={H - 6} fontSize={11} fill="#e37400">
                  {m.name}
                </text>
              </g>
            );
          })}
      </svg>
    </div>
  );
}
