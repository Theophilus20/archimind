import { useState } from 'react';
import { useStudio, newTaskId } from '../state/store';
import { navigate } from '../ui/router';
import { Dialog, Icon, IdTag, fmtDate } from '../ui/common';
import type { ScheduledTask } from '../schedule/scheduler';
import type { Task, TaskStatus } from '../model/types';
import { draftTaskDetails } from '../schedule/details';

const STATUS: [TaskStatus, string, string][] = [
  ['todo', 'radio_button_unchecked', 'To do'],
  ['doing', 'pending', 'Doing'],
  ['done', 'check_circle', 'Done'],
];

const ORIGIN_TEXT: Record<Task['origin'], string> = {
  brief: 'Made from the brief',
  finding: 'Made from a review finding',
  revision: 'Made from a saved revision',
  message: 'Made from a crit message',
  manual: 'Added by hand',
  ai: 'Drafted by AI',
};

/**
 * Open a task to see and change everything about it: what it is, notes, who does it,
 * how long it takes, when it is due and what it waits for. With no `task`, it creates one.
 */
export function TaskDialog({ task, scheduled, initialTitle = '', onClose }: { task?: Task; scheduled?: ScheduledTask; initialTitle?: string; onClose: () => void }) {
  const project = useStudio((s) => s.project);
  const updateTask = useStudio((s) => s.updateTask);
  const removeTask = useStudio((s) => s.removeTask);
  const addTasks = useStudio((s) => s.addTasks);
  const focusOn = useStudio((s) => s.focusOn);
  const creating = !task;
  /** Older generated tasks have no saved details yet: show ArchiMind's draft so there is always something to go on. */
  const drafted = !!task && !task.notes && task.origin !== 'manual';
  const [draft, setDraft] = useState<Task>(
    () =>
      (task && (drafted ? { ...task, notes: draftTaskDetails(task, project) || undefined } : task)) ?? {
        id: newTaskId(),
        title: initialTitle,
        owner: project.brief.mode === 'studio' ? 'Student' : 'Architect',
        effortHours: 2,
        deps: [],
        status: 'todo',
        origin: 'manual',
        links: { elementIds: [], findingIds: [] },
        createdAt: Date.now(),
      },
  );
  const set = (patch: Partial<Task>) => setDraft((d) => ({ ...d, ...patch }));
  const others = project.tasks.filter((t) => t.id !== draft.id);
  const findings = project.findings.filter((f) => draft.links.findingIds.includes(f.id));
  const owners = [...new Set([...project.members.map((m) => m.name), 'Student', 'Architect'])];
  const valid = draft.title.trim().length > 0 && draft.effortHours > 0;

  const save = () => {
    if (!valid) return;
    const clean: Task = { ...draft, title: draft.title.trim(), notes: draft.notes?.trim() || undefined, deliverable: draft.deliverable?.trim() || undefined };
    if (creating) addTasks([clean]);
    else updateTask(clean.id, clean);
    onClose();
  };

  return (
    <Dialog
      title={creating ? 'New task' : 'Task details'}
      onClose={onClose}
      actions={
        <>
          {!creating && (
            <button
              className="btn btn-text"
              style={{ color: 'var(--red)', marginRight: 'auto' }}
              onClick={() => {
                removeTask(draft.id);
                onClose();
              }}
            >
              <Icon name="delete" /> Delete task
            </button>
          )}
          <button className="btn btn-text" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!valid}>
            {creating ? 'Add task' : 'Save'}
          </button>
        </>
      }
    >
      <div className="task-form">
        <div className="field">
          <label htmlFor="task-title">Task</label>
          <input id="task-title" className="input" autoFocus={creating} value={draft.title} placeholder="What needs doing?" onChange={(e) => set({ title: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
        <div className="field">
          <label htmlFor="task-notes">
            Details{draft.origin !== 'manual' && <span className="faint" style={{ fontWeight: 400 }}> · written by ArchiMind, change anything</span>}
          </label>
          <textarea id="task-notes" className="input" rows={draft.origin === 'manual' ? 4 : 8} value={draft.notes ?? ''} placeholder="Steps, references, what “done” looks like…" onChange={(e) => set({ notes: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="task-deliverable">Deliverable</label>
          <input id="task-deliverable" className="input" value={draft.deliverable ?? ''} placeholder="e.g. Ground floor plan at 1:100" onChange={(e) => set({ deliverable: e.target.value })} />
        </div>
        <div className="task-grid">
          <div className="field">
            <label htmlFor="task-owner">Who</label>
            <input id="task-owner" className="input" list="task-owners" value={draft.owner} onChange={(e) => set({ owner: e.target.value })} />
            <datalist id="task-owners">
              {owners.map((o) => (
                <option key={o} value={o} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label htmlFor="task-effort">Effort (hours)</label>
            <input id="task-effort" className="input" type="number" min={0.25} step={0.5} value={draft.effortHours} onChange={(e) => set({ effortHours: Math.max(0, Number(e.target.value)) })} />
          </div>
          <div className="field">
            <label htmlFor="task-due">Due by</label>
            <input id="task-due" className="input" type="date" value={draft.deadline ?? ''} max={project.brief.deadline} onChange={(e) => set({ deadline: e.target.value || undefined })} />
          </div>
        </div>
        <div className="field">
          <label>Status</label>
          <div className="seg">
            {STATUS.map(([s, icon, label]) => (
              <button key={s} className={draft.status === s ? 'on' : ''} onClick={() => set({ status: s })}>
                <Icon name={icon} /> {label}
              </button>
            ))}
          </div>
        </div>
        {others.length > 0 && (
          <div className="field">
            <label>Starts after</label>
            <div className="task-deps">
              {others.map((t) => (
                <label key={t.id} className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={draft.deps.includes(t.id)} onChange={(e) => set({ deps: e.target.checked ? [...draft.deps, t.id] : draft.deps.filter((d) => d !== t.id) })} />
                  <span className="grow">{t.title}</span>
                  {t.status === 'done' && <span className="chip ok" style={{ height: 18 }}>done</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        {!creating && (
          <div className="task-facts">
            {scheduled && (
              <div className="row small" style={{ gap: 6 }}>
                <Icon name="event" size={16} />
                Scheduled {fmtDate(scheduled.start)} → {fmtDate(scheduled.end)}
                {scheduled.late ? <span className="chip error">late, due {fmtDate(scheduled.due)}</span> : scheduled.critical ? <span className="chip warn">on the critical chain</span> : <span className="chip">{scheduled.slackDays} day{scheduled.slackDays === 1 ? '' : 's'} spare</span>}
              </div>
            )}
            <div className="row small muted" style={{ gap: 6 }}>
              <Icon name="info" size={16} />
              {ORIGIN_TEXT[draft.origin]} on {new Date(draft.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
              {draft.links.revision ? ` · revision ${draft.links.revision}` : ''}
            </div>
            {findings.map((f) => (
              <button
                key={f.id}
                className="task-link"
                onClick={() => {
                  onClose();
                  navigate('review', { finding: f.id });
                }}
              >
                <Icon name="flag" size={16} /> {f.title}
              </button>
            ))}
            {draft.links.messageId && (
              <button
                className="task-link"
                onClick={() => {
                  onClose();
                  navigate('crit');
                }}
              >
                <Icon name="forum" size={16} /> Open the crit message
              </button>
            )}
            {draft.links.elementIds.length > 0 && (
              <div className="row wrap" style={{ gap: 4 }}>
                {draft.links.elementIds.map((id) => (
                  <IdTag key={id} id={id} />
                ))}
                <button
                  className="btn btn-text btn-sm"
                  onClick={() => {
                    focusOn(draft.links.elementIds);
                    onClose();
                    navigate('studio');
                  }}
                >
                  <Icon name="my_location" /> Show in the studio
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
