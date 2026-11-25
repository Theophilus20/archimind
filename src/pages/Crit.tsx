import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStudio, roleLabel, roleLabelFor, newTaskId } from '../state/store';
import { useCollab, sendMessage, setResolved, setErased, updatePresence, editMessage, deleteMessage } from '../collab/collab';
import { useRoute, navigate } from '../ui/router';
import { Viewer3D, viewerApi, type ViewerSettings } from '../studio/Viewer3D';
import { Plan2D, type MarkTool, type ShownMark } from '../studio/Plan2D';
import { useIsOwner, useMyAccess } from '../firebase/access';
import { withDetails } from '../schedule/details';
import { FigurePreview } from '../ui/FigurePreview';
import { lookFor } from '../studio/People';
import { derive } from '../model/derive';
import { PreviewBar } from '../studio/PreviewBar';
import { usePins } from '../studio/usePins';
import { useAids } from '../studio/aids';
import { Avatar, Dialog, Icon, IdTag, SourceChip, Spinner, Switch, timeAgo, useNow } from '../ui/common';
import { critMinutes, feedbackToIntent, proposeEdit, translateMessage, type Minutes } from '../ai/requests';
import { LocalModelUnavailable } from '../ai/hybrid';
import { describeElement } from '../ai/context';
import { describeEdit, nextId, primaryIds } from '../model/edits';
import type { AISource, BuildingModel, EditOp, Id, Member, Message, PlanMark, Proposal } from '../model/types';
import type { Mark3D } from '../studio/Marks3D';
import { wallDir, wallLength } from '../model/geometry';
import { uploadDataUrl } from '../firebase/storage';
import { track } from '../firebase/config';

async function snapshot(): Promise<string | undefined> {
  const url = viewerApi.capture?.();
  if (!url) return undefined;
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => undefined);
  const w = 360;
  const h = Math.round((img.height / Math.max(1, img.width)) * w) || 200;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')?.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', 0.72);
}

const SAMPLE: Omit<Message, 'id' | 'createdAt'>[] = [
  {
    threadId: 'D1',
    authorId: 'u-tutor',
    authorName: 'Prof. Ruiz',
    role: 'lecturer',
    text: 'Bedroom 1 opens straight onto the living room through D1. Given your privacy goal, is that intended? Look at the circulation from the hall.',
    kind: 'text',
    anchor: { elementIds: ['D1', 'R1'], revision: 1 },
  },
  {
    threadId: 'R6',
    authorId: 'u-tutor2',
    authorName: 'Dr. Bello',
    role: 'lecturer',
    text: 'The living room light is lovely, but the kitchen will feel cramped when the whole family cooks together. And where do the children do their homework quietly?',
    kind: 'text',
    anchor: { elementIds: ['R6'], revision: 1 },
  },
  {
    threadId: 'studio',
    authorId: 'u-student',
    authorName: 'Ada Mensah',
    role: 'student',
    text: 'Thanks both. I agree the door should come off the hall instead. I could also move the desk F4 in Bedroom 2 under the window for better light. Should the study come out of Bedroom 1?',
    kind: 'text',
  },
];

export function CritPage() {
  const { params } = useRoute();
  const project = useStudio((s) => s.project);
  const me = useStudio((s) => s.me);
  const preview = useStudio((s) => s.preview);
  const selection = useStudio((s) => s.selection);
  const lastCamera = useStudio((s) => s.lastCamera);
  const focusOn = useStudio((s) => s.focusOn);
  const startPreview = useStudio((s) => s.startPreview);
  const addTasks = useStudio((s) => s.addTasks);
  const toast = useStudio((s) => s.toast);
  const messages = useCollab((s) => s.messages);
  const presence = useCollab((s) => s.presence);
  const following = useCollab((s) => s.following);
  const setFollowing = useCollab((s) => s.setFollowing);
  const now = useNow(15000);
  /** Dimensions on the plan: a per-person view setting, shared with the studio's DIMS switch. */
  const dims = useAids((s) => s.dims);
  const toggleAid = useAids((s) => s.toggle);

  const [thread, setThread] = useState<string>(params.get('anchor') ?? params.get('finding') ?? 'all');
  const [text, setText] = useState('');
  const [pinView, setPinView] = useState(Boolean(params.get('anchor')));
  const [presenting, setPresenting] = useState(false);
  const [plainLanguage, setPlainLanguage] = useState(me.role === 'client');
  const [translations, setTranslations] = useState<Record<Id, { text: string; source: AISource; glossary: { term: string; meaning: string }[] }>>({});
  const [minutes, setMinutes] = useState<{ data: Minutes; source: AISource; ms: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draftProposal, setDraftProposal] = useState<Proposal | null>(null);
  const [view, setView] = useState<'3d' | 'plan'>('3d');
  const [mobileTab, setMobileTab] = useState<'chat' | 'model' | 'threads'>('chat');
  const listRef = useRef<HTMLDivElement>(null);
  const [walking, setWalking] = useState(false);
  const access = useMyAccess();
  const canEdit = access === 'full';
  /** AI minutes are the project owner's tool; invited people don't see the button. */
  const isOwner = useIsOwner();
  /** Message being corrected, and the message waiting for a delete confirmation. */
  const [editing, setEditing] = useState<{ id: Id; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Id | null>(null);
  const saveEdit = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    const m = messages.find((x) => x.id === editing.id);
    setEditing(null);
    if (!m || !text || text === m.text) return;
    const mentions = mentionable.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id);
    try {
      await editMessage(m.id, text, mentions);
    } catch {
      toast('Couldn’t save your change. Check your connection and try again.', 'error');
    }
  };
  const doDelete = async (id: Id) => {
    setConfirmDelete(null);
    try {
      await deleteMessage(id);
    } catch {
      toast('Couldn’t delete the message. Check your connection and try again.', 'error');
    }
  };
  const canMark = access !== 'crit';
  const [markTool, setMarkTool] = useState<MarkTool | null>(null);
  const [markColor, setMarkColor] = useState(MARK_COLORS[0].c);
  const [drafts, setDrafts] = useState<PlanMark[]>([]);
  const [tool3d, setTool3d] = useState<'pin' | 'part' | 'eraser' | null>(null);
  const [noteFor, setNoteFor] = useState<PlanMark | null>(null);
  const [noteText, setNoteText] = useState('');
  const addDraft = (m: PlanMark) => setDrafts((d) => [...d, { ...m, id: `m${Date.now().toString(36)}${d.length}`, level: project.model.activeLevel ?? 0 }]);
  const [focusMsg, setFocusMsg] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  // Everyone known in this project: members, people in the room now, and you.
  const people = useMemo(() => {
    const map = new Map<string, Member>();
    for (const m of project.members) map.set(m.id, m);
    for (const p of Object.values(presence)) map.set(p.member.id, { ...map.get(p.member.id), ...p.member });
    map.set(me.id, me);
    return map;
  }, [project.members, presence, me]);
  const mentionable = [...people.values()].filter((p) => p.id !== me.id && p.id !== 'ai' && p.name);
  const mentionMatches = mention ? mentionable.filter((p) => p.name.toLowerCase().includes(mention.query.toLowerCase())).slice(0, 6) : [];
  // Share the mark you are writing about, so others see it before you send.
  useEffect(() => updatePresence({ draftMarks: drafts.map(({ id: _id, ...m }) => m) }), [drafts]);
  const settings: ViewerSettings = { mode: walking ? 'walk' : 'orbit', hour: 15, section: null, roof: false, furniture: true, doorsOpen: true, people: false };
  const model = preview?.model ?? project.model;
  const pins = usePins({ findings: false, onMessage: (id) => setThread(messages.find((m) => m.id === id)?.anchor?.elementIds[0] ?? 'all') });
  const previewIds = useMemo(() => new Set(preview ? preview.proposal.edits.flatMap(primaryIds) : []), [preview]);

  // Anchor from the query string (from Studio "Discuss" or a finding).
  useEffect(() => {
    const a = params.get('anchor');
    const f = params.get('finding');
    if (a) focusOn([a]);
    if (f) {
      const fd = project.findings.find((x) => x.id === f);
      if (fd?.evidence.elementIds.length) {
        focusOn(fd.evidence.elementIds);
        setThread(fd.evidence.elementIds[0]);
        setPinView(true);
        setText((t) => t || `Re: ${fd.title}: `);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => updatePresence({ presenting, selection }), [presenting, selection]);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, thread, minutes]);

  // Threads: one per anchored element, plus the studio channel.
  const threads = useMemo(() => {
    const map = new Map<string, { id: string; count: number; open: number; last: number }>();
    for (const m of messages) {
      const key = m.anchor?.elementIds[0] ?? 'studio';
      const t = map.get(key) ?? { id: key, count: 0, open: 0, last: 0 };
      t.count++;
      if (m.kind === 'text' && m.anchor && !m.resolved && m.authorId !== me.id) t.open++;
      t.last = Math.max(t.last, m.createdAt);
      map.set(key, t);
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
  }, [messages, me.id]);

  const visible = thread === 'all' ? messages : messages.filter((m) => (m.anchor?.elementIds.includes(thread) ?? false) || m.threadId === thread || (thread === 'studio' && !m.anchor));

  // Plain-language mode: translate others' messages on-device as they arrive.
  useEffect(() => {
    if (!plainLanguage) return;
    const pending = visible.filter((m) => m.kind === 'text' && m.authorId !== me.id && !translations[m.id]).slice(0, 3);
    pending.forEach(async (m) => {
      try {
        const r = await translateMessage(project.model, m.text, me.role === 'architect' || me.role === 'lecturer' ? 'architect' : me.role);
        setTranslations((t) => ({ ...t, [m.id]: { text: r.data.text, source: r.source, glossary: r.data.glossary } }));
      } catch (e) {
        if (e instanceof LocalModelUnavailable) {
          setPlainLanguage(false);
          toast(e.message, 'error');
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plainLanguage, visible.length]);

  const sending = useRef(false);
  const send = async () => {
    const body = text.trim();
    if (!body || sending.current) return;
    sending.current = true;
    // Clear the box straight away; the message appears in the thread at once and syncs in the background.
    setText('');
    const draftsNow = drafts;
    const proposalNow = draftProposal;
    const replyNow = replyTo;
    const mentionIds = mentionable.filter((p) => body.includes(`@${p.name}`)).map((p) => p.id);
    setReplyTo(null);
    setMention(null);
    setDraftProposal(null);
    setDrafts([]);
    setTool3d(null);
    setMarkTool(null);
    try {
    // A mark on the plan belongs to the room it sits in.
    const first = draftsNow.find((m) => m.kind !== 'part' && m.kind !== 'remove') ?? draftsNow[0];
    const markRoom = first ? (derive(project.model).roomAt(markCenter(first))?.id ?? first.elementId) : undefined;
    const clean = draftsNow.map(({ id: _id, ...m }) => JSON.parse(JSON.stringify(m)) as PlanMark);
    const anchorIds = markRoom ? [markRoom] : pinView ? (selection.length ? selection : thread !== 'all' && thread !== 'studio' ? [thread] : []) : thread !== 'all' && thread !== 'studio' ? [thread] : [];
    const snapData = pinView && view === '3d' ? await snapshot() : undefined;
    // Snapshots go to Cloud Storage; the message keeps only the URL (data URL fallback offline / demo).
    const snap = snapData ? ((await uploadDataUrl(`projects/${project.id}/snapshots/${Date.now().toString(36)}.jpg`, snapData).catch(() => null)) ?? snapData) : undefined;
    track('crit_message_sent', { pinned: Boolean(pinView), proposal: Boolean(proposalNow), role: me.role });
    await sendMessage({
      threadId: anchorIds[0] ?? 'studio',
      authorId: me.id,
      authorName: me.name,
      role: me.role,
      text: body,
      kind: 'text',
      anchor: anchorIds.length || pinView || clean.length ? { elementIds: anchorIds, view: pinView ? lastCamera ?? undefined : undefined, revision: project.model.revision, snapshot: snap, ...(clean.length ? { mark: clean[0], marks: clean } : {}) } : undefined,
      proposal: proposalNow ?? undefined,
      ...(replyNow ? { replyTo: { id: replyNow.id, authorName: replyNow.authorName, text: replyNow.text.slice(0, 140) } } : {}),
      ...(mentionIds.length ? { mentions: mentionIds } : {}),
    });
    } finally {
      sending.current = false;
    }
  };

  // Numbered marks: everyone's sent marks, your drafts, and marks others are drafting right now.
  const marksOf = (m: Message) => (m.erased ? [] : (m.anchor?.marks ?? (m.anchor?.mark ? [m.anchor.mark] : [])));
  const marked = messages.filter((m) => marksOf(m).length);
  const erasing = markTool === 'eraser' || tool3d === 'eraser';
  const focusMessage = (id: string) => {
    setFocusMsg(id);
    setThread('all');
    setMobileTab('chat');
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const shownMarks: ShownMark[] = [
    ...marked.flatMap((m, i) =>
      marksOf(m).map((mk, j) => ({
        id: `${m.id}-${j}`,
        n: i + 1,
        mark: mk,
        label: `${m.authorName}: ${m.text.slice(0, 80)}`,
        active: focusMsg === m.id,
        resolved: m.resolved,
        onClick: () => focusMessage(m.id),
        // Authors erase their own marks; the owner and full members can tidy up anyone's.
        onErase: m.authorId === me.id || canEdit ? () => (setErased(m.id), toast(m.authorId === me.id ? 'Your marks on that message were erased' : `Erased ${m.authorName}'s marks on that message`, 'info')) : undefined,
      })),
    ),
    ...drafts.map((mk) => ({ id: `draft-${mk.id}`, n: 0, mark: mk, label: 'Your new mark (not sent yet)', active: true, onClick: () => undefined, onErase: () => setDrafts((d) => d.filter((x) => x.id !== mk.id)) })),
    ...Object.values(presence).flatMap((p) => (p.draftMarks ?? []).map((mk, j) => ({ id: `live-${p.member.id}-${j}`, n: 0, mark: mk, label: `${p.member.name} is writing about this`, onClick: () => undefined }))),
  ];
  const marks3d: Mark3D[] = shownMarks.map((s) => ({ id: s.id, n: s.n, mark: s.mark, label: s.label, onClick: erasing ? s.onErase : s.onClick }));
  const markNumber = (id: string) => marked.findIndex((m) => m.id === id) + 1;

  const run = async <T,>(key: string, fn: () => Promise<T>) => {
    setBusy(key);
    try {
      return await fn();
    } catch (e) {
      toast(e instanceof LocalModelUnavailable ? e.message : (e as Error).message, 'error');
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const doMinutes = () =>
    isOwner &&
    run('minutes', async () => {
      const r = await critMinutes(project.model, visible);
      setMinutes({ data: r.data, source: r.source, ms: r.latencyMs });
    });

  const doIntent = (m: Message) =>
    run(`intent-${m.id}`, async () => {
      const r = await feedbackToIntent(project.model, project.brief, project.findings, m.text);
      const lines = r.data.intents.map((i) => `• ${i.statement}. Check: ${i.measure}${i.elementIds.length ? ` [${i.elementIds.join(', ')}]` : ''}`).join('\n');
      await sendMessage({
        threadId: m.threadId,
        authorId: 'ai',
        authorName: 'ArchiMind',
        role: me.role,
        text: `Design intent from ${m.authorName}'s feedback:\n${lines}`,
        kind: 'intent',
        anchor: { elementIds: [...new Set(r.data.intents.flatMap((i) => i.elementIds))], revision: project.model.revision },
        ai: { source: r.source, requestType: 'message.intent' },
      });
    });

  const doTranslate = (m: Message) =>
    run(`tr-${m.id}`, async () => {
      const r = await translateMessage(project.model, m.text, 'client');
      setTranslations((t) => ({ ...t, [m.id]: { text: r.data.text, source: r.source, glossary: r.data.glossary } }));
    });

  const doPropose = () =>
    run('propose', async () => {
      const r = await proposeEdit(project.model, project.brief, project.findings, text);
      if (!r.data) {
        toast('No valid structured edit could be derived from that message. Try naming an element, e.g. “move wall W6 300 mm”.', 'error');
        return;
      }
      setDraftProposal(r.data);
      toast(`Proposal drafted (${r.source === 'on_device' ? 'on device' : r.source === 'in_cloud' ? 'cloud' : 'heuristic'}) and validated`, 'success');
    });

  const addActions = () => {
    if (!minutes) return;
    const tasks = minutes.data.actions.map((a) => ({
      id: newTaskId(),
      title: a.title,
      owner: roleLabel(a.owner),
      effortHours: a.effortHours,
      deps: [],
      status: 'todo' as const,
      origin: 'message' as const,
      links: { elementIds: a.elementIds, findingIds: [], revision: project.model.revision },
      deliverable: 'Crit actions',
      createdAt: Date.now(),
    }));
    addTasks(withDetails(tasks, project, { crit: minutes.data.summary }));
    toast(`${tasks.length} crit actions added to the schedule`, 'success');
  };

  const postMinutes = async () => {
    if (!minutes) return;
    const m = minutes.data;
    await sendMessage({
      threadId: 'studio',
      authorId: 'ai',
      authorName: 'ArchiMind minutes',
      role: me.role,
      kind: 'minutes',
      text: `${m.summary}\n\nDecisions:\n${m.decisions.map((d) => `• ${d}`).join('\n') || '• none'}\n\nActions:\n${m.actions.map((a) => `• ${a.title} (${roleLabel(a.owner)}, ~${a.effortHours} h)`).join('\n') || '• none'}${m.openQuestions.length ? `\n\nOpen questions:\n${m.openQuestions.map((q) => `• ${q}`).join('\n')}` : ''}`,
      ai: { source: minutes.source, requestType: 'thread.minutes' },
    });
    setMinutes(null);
  };

  const others = Object.values(presence);
  const presenter = others.find((p) => p.presenting);

  return (
    <div className="crit" data-mobile={mobileTab}>
      <div className="mobile-tabs" role="tablist">
        {(
          [
            ['chat', 'chat', 'Conversation'],
            ['model', 'view_in_ar', 'Model'],
            ['threads', 'group', `People · ${Object.keys(presence).length + 1}`],
          ] as const
        ).map(([k, icon, label]) => (
          <button key={k} role="tab" aria-selected={mobileTab === k} className={mobileTab === k ? 'on' : ''} onClick={() => setMobileTab(k)}>
            <Icon name={icon} /> {label}
          </button>
        ))}
      </div>
      {/* Threads & people */}
      <aside className="thread" style={{ overflowY: 'auto' }}>
        <div className="inspector-section">
          <h3>In the room</h3>
          <div className="row" style={{ padding: '4px 0' }}>
            <button className="avatar-btn" onClick={() => setProfile(me.id)} title="View your profile">
              <Avatar m={me} size={28} />
            </button>
            <span className="grow">
              {me.name} <span className="small muted">· {roleLabel(me.role)} (you)</span>
            </span>
          </div>
          {others.length === 0 && <div className="small muted" style={{ padding: '6px 0' }}>Nobody else here yet. Invite a coursemate or lecturer from the project menu (top left) and they will appear here when they open the link.</div>}
          {others.map((p) => (
            <div key={p.member.id} className="row" style={{ padding: '4px 0' }}>
              <button className="avatar-btn" onClick={() => setProfile(p.member.id)} title={`View ${p.member.name}'s profile`}>
                <Avatar m={p.member} size={28} />
              </button>
              <span className="grow">
                {p.member.name} <span className="small muted">· {roleLabelFor(p.member.role, me.role)}</span>
                {p.presenting && <span className="chip blue" style={{ marginLeft: 6, height: 20 }}>presenting</span>}
                {p.away && <span className="chip" style={{ marginLeft: 6, height: 20 }} title="Their ArchiMind window is in the background">away</span>}
              </span>
              {p.presenting && (
                <button className={`btn btn-sm ${following === p.member.id ? 'btn-primary' : 'btn-outline'}`} onClick={() => setFollowing(following === p.member.id ? null : p.member.id)}>
                  {following === p.member.id ? 'Following' : 'Follow'}
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <div className="row" style={{ marginTop: 10 }}>
              <Switch on={presenting} onChange={setPresenting} label="Present my view" />
              <span className="small">Present my view so others can follow along</span>
            </div>
          )}
        </div>
        <div className="inspector-section" style={{ borderBottom: 0 }}>
          <h3>Threads</h3>
          <button className={`nav-item ${thread === 'all' ? 'active' : ''}`} style={{ color: 'var(--text)', width: '100%', borderRadius: 18, margin: 0, padding: '0 12px' }} onClick={() => setThread('all')}>
            <Icon name="forum" /> <span>All messages</span> <span className="count" style={{ color: 'var(--text-2)', background: 'var(--surface-2)' }}>{messages.length}</span>
          </button>
          {threads.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${thread === t.id ? 'active' : ''}`}
              style={{ color: 'var(--text)', width: '100%', borderRadius: 18, margin: 0, padding: '0 12px', height: 'auto', minHeight: 40 }}
              onClick={() => {
                setThread(t.id);
                if (t.id !== 'studio') focusOn([t.id]);
                setMobileTab('chat');
              }}
            >
              <Icon name={t.id === 'studio' ? 'tag' : 'push_pin'} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.id === 'studio' ? 'Studio channel' : describeElement(project.model, t.id)}</span>
              {t.open > 0 && <span className="count" style={{ background: '#f3e8fd', color: '#7b1fa2' }}>{t.open}</span>}
            </button>
          ))}
          {messages.length === 0 && (
            <div className="col" style={{ marginTop: 12 }}>
              <div className="small muted">No conversation yet.</div>
              <button
                className="btn btn-outline btn-sm"
                onClick={async () => {
                  for (const m of SAMPLE) await sendMessage(m);
                }}
              >
                <Icon name="playlist_add" /> Load sample crit
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Shared model */}
      <div className="pane" style={{ borderRight: '1px solid var(--border)' }}>
        <div className="pane-label">
          <div className="seg">
            <button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}>
              <Icon name="view_in_ar" /> 3D
            </button>
            <button className={view === 'plan' ? 'on' : ''} onClick={() => (setView('plan'), setWalking(false))}>
              <Icon name="grid_on" /> Plan
            </button>
          </div>
          {view === 'plan' && (
            <button className={`chip clickable ${dims ? 'blue' : ''}`} onClick={() => toggleAid('dims')} aria-pressed={dims} title="Show or hide all dimensions on the plan. Only changes your own screen.">
              <Icon name="straighten" /> {dims ? 'Hide dimensions' : 'Show dimensions'}
            </button>
          )}
          {view === '3d' && !walking && canMark && (
            <button
              className="chip clickable"
              onClick={() => setTool3d((t) => (t ? null : 'part'))}
              title="Pin a spot or highlight a part of the 3D model"
            >
              <Icon name="draw" /> Mark up
            </button>
          )}
          {view === '3d' && !walking && (
            <button className="chip clickable blue" onClick={() => setWalking(true)} title="Walk through the model; others in the room see you as a figure">
              <Icon name="directions_walk" /> Walk in together
            </button>
          )}
          {presenting && (
            <span className="chip blue">
              <Icon name="cast" /> You are presenting
            </span>
          )}
          {following && presenter && (
            <span className="chip blue">
              <Icon name="visibility" /> Following {presenter.member.name}
            </span>
          )}
          {!following && presenter && (
            <button className="chip clickable blue" onClick={() => setFollowing(presenter.member.id)}>
              <Icon name="cast_connected" /> {presenter.member.name} is presenting. Follow
            </button>
          )}
        </div>
        {canMark && view === 'plan' && (
          <div className="markup-bar" role="toolbar" aria-label="Mark up the plan">
            <div className="markup-tools">
            {PLAN_TOOLS.map((t, i) =>
              t === '|' ? (
                <span key={`sep${i}`} className="markup-sep" />
              ) : (
                <button
                  key={t[0]}
                  className={`markup-tool ${markTool === t[0] ? 'on' : ''}`}
                  title={t[2]}
                  onClick={() => {
                    setMarkTool((cur) => (cur === t[0] ? null : t[0]));
                    setWalking(false);
                  }}
                >
                  <Icon name={t[1]} /> <span className="lbl">{t[3]}</span>
                </button>
              ),
            )}
            </div>
            <div className="markup-colours" role="radiogroup" aria-label="What the mark means">
              {MARK_COLORS.map((m) => (
                <button key={m.c} role="radio" aria-checked={markColor === m.c} className={`markup-chip ${markColor === m.c ? 'on' : ''}`} style={{ ['--c' as string]: m.c }} onClick={() => setMarkColor(m.c)}>
                  <span className="dot" style={{ background: m.c }} /> {m.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {canMark && view === '3d' && !walking && tool3d && (
          <div className="markup-bar" role="toolbar" aria-label="Mark up the 3D model">
            <div className="markup-tools">
            {(
              [
                ['part', 'ads_click', 'Highlight a part'],
                ['pin', 'location_on', 'Pin a spot'],
                ['eraser', 'ink_eraser', 'Erase marks'],
              ] as ['part' | 'pin' | 'eraser', string, string][]
            ).map(([t, icon, label]) => (
              <button key={t} className={`markup-tool ${tool3d === t ? 'on' : ''}`} title={label} onClick={() => setTool3d(t)}>
                <Icon name={icon} /> <span className="lbl">{label}</span>
              </button>
            ))}
            <button className="markup-tool" title="Done" onClick={() => setTool3d(null)}>
              <Icon name="check" /> <span className="lbl" style={{ display: 'inline' }}>Done</span>
            </button>
            </div>
            <div className="markup-colours" role="radiogroup" aria-label="What the mark means">
              {MARK_COLORS.map((m) => (
                <button key={m.c} role="radio" aria-checked={markColor === m.c} className={`markup-chip ${markColor === m.c ? 'on' : ''}`} style={{ ['--c' as string]: m.c }} onClick={() => setMarkColor(m.c)}>
                  <span className="dot" style={{ background: m.c }} /> {m.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {noteFor && (
          <form
            className="note-bar"
            onSubmit={(e) => {
              e.preventDefault();
              if (noteText.trim()) addDraft({ ...noteFor, text: noteText.trim().slice(0, 80) });
              setNoteFor(null);
              setNoteText('');
            }}
          >
            <Icon name="sticky_note_2" style={{ color: noteFor.color }} />
            <input className="input input-sm" autoFocus maxLength={80} value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Write the note to place on the plan" />
            <button className="btn btn-primary btn-sm" type="submit" disabled={!noteText.trim()}>
              Add
            </button>
            <button className="btn btn-text btn-sm" type="button" onClick={() => setNoteFor(null)}>
              Cancel
            </button>
          </form>
        )}
        {view === '3d' ? (
          <Viewer3D
            model={model}
            settings={settings}
            pins={pins}
            previewIds={previewIds}
            onExitWalk={() => setWalking(false)}
            markTool3d={canMark && tool3d && tool3d !== 'eraser' ? tool3d : null}
            markColor={markColor}
            onMark3d={(m) => {
              addDraft(m);
              setTimeout(() => textRef.current?.focus(), 50);
            }}
            marks3d={marks3d}
          />
        ) : (
          <Plan2D
            model={model}
            ghost={preview ? project.model : null}
            previewIds={previewIds}
            pins={pins}
            editable={false}
            showUnderlay={false}
            markTool={canMark ? markTool : null}
            markColor={markColor}
            marks={shownMarks}
            draftMark={null}
            onMark={(m) => {
              if (m.kind === 'text') {
                setNoteFor(m);
                return;
              }
              addDraft(m);
              setTimeout(() => textRef.current?.focus(), 50);
            }}
          />
        )}
        <PreviewBar />
      </div>

      {/* Conversation */}
      <section className="thread" aria-label="Conversation">
        <div className="card-header" style={{ padding: '12px 16px' }}>
          <div className="grow">
            <div style={{ fontWeight: 500 }}>{thread === 'all' ? 'All messages' : thread === 'studio' ? 'Studio channel' : describeElement(project.model, thread)}</div>
            <div className="small muted">{visible.length} messages · pinned to the model</div>
          </div>
          {isOwner && (
            <button className="btn btn-tonal btn-sm" onClick={doMinutes} disabled={!visible.length || busy === 'minutes'} title="Summarise decisions and actions with AI (only you can see this)">
              {busy === 'minutes' ? <Spinner size={16} /> : <Icon name="summarize" />} Minutes
            </button>
          )}
        </div>
        <div className="row small" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-2)', gap: 8 }}>
          <Switch on={plainLanguage} onChange={setPlainLanguage} label="Plain language" />
          <span className="grow">{me.role === 'client' ? 'Plain-language view for clients' : 'Plain-language view'}, rewritten on this device</span>
        </div>

        <div className="messages" ref={listRef}>
          {visible.map((m) => {
            const mine = m.authorId === me.id;
            const tr = translations[m.id];
            const author = project.members.find((x) => x.id === m.authorId) ?? { name: m.authorName, color: m.authorId === 'ai' ? '#5f6368' : m.role === 'client' ? '#188038' : m.role === 'lecturer' ? '#e37400' : '#1a73e8' };
            return (
              <div key={m.id} id={`msg-${m.id}`} className={`msg ${mine ? 'mine' : ''} ${m.kind !== 'text' ? 'system' : ''} ${focusMsg === m.id ? 'focused' : ''} ${!mine && m.mentions?.includes(me.id) ? 'mention-me' : ''}`}>
                {m.authorId === 'ai' ? (
                  <span className="avatar" style={{ background: '#2b3242' }}>
                    <Icon name="auto_awesome" size={16} style={{ color: '#ffca28' }} />
                  </span>
                ) : (
                  <button className="avatar-btn" onClick={() => setProfile(m.authorId)} title={`View ${m.authorName}'s profile`}>
                    <Avatar m={{ id: m.authorId, name: m.authorName, color: people.get(m.authorId)?.color ?? author.color, photo: people.get(m.authorId)?.photo }} />
                  </button>
                )}
                <div style={{ minWidth: 0 }}>
                  <div className="meta">
                    {m.authorId === 'ai' ? (
                      <b style={{ color: 'var(--text)' }}>{m.authorName}</b>
                    ) : (
                      <button className="name-btn" onClick={() => setProfile(m.authorId)}>
                        {m.authorName}
                      </button>
                    )}
                    {m.authorId !== 'ai' && <span>{m.authorId === me.id ? roleLabel(m.role) : roleLabelFor(m.role, me.role)}</span>}
                    <span>· {timeAgo(m.createdAt, now)}</span>
                    {m.editedAt && <span title={`Edited ${new Date(m.editedAt).toLocaleString()}`}>· edited</span>}
                    {m.ai && <SourceChip source={m.ai.source} compact />}
                    {m.resolved && <span className="chip ok" style={{ height: 18 }}>resolved</span>}
                  </div>
                  <div className="bubble">
                    {m.replyTo && (
                      <button className="reply-quote" onClick={() => focusMessage(m.replyTo!.id)} title="Show the message this replies to">
                        <b>{m.replyTo.authorName}</b>
                        <span>{m.replyTo.text}</span>
                      </button>
                    )}
                    {editing?.id === m.id ? (
                      <div className="msg-edit">
                        <textarea
                          autoFocus
                          value={editing.text}
                          rows={Math.min(6, Math.max(2, editing.text.split('\n').length))}
                          aria-label="Edit your message"
                          onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              void saveEdit();
                            } else if (e.key === 'Escape') setEditing(null);
                          }}
                        />
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <span className="small faint grow">Enter to save · Esc to cancel</span>
                          <button className="btn btn-text btn-sm" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button className="btn btn-primary btn-sm" onClick={() => void saveEdit()} disabled={!editing.text.trim()}>
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ whiteSpace: 'pre-wrap' }}>{plainLanguage && tr ? tr.text : withMentions(m.text, mentionable.concat(me), me.id)}</div>
                    )}
                    {tr && (
                      <div className="small" style={{ marginTop: 6, color: 'var(--text-2)' }}>
                        <div className="row" style={{ gap: 4 }}>
                          <Icon name="translate" size={14} /> {plainLanguage ? 'Plain-language rewrite' : tr.text}
                          <SourceChip source={tr.source} compact />
                        </div>
                        {tr.glossary.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            {tr.glossary.map((g) => (
                              <div key={g.term}>
                                <b>{g.term}</b>: {g.meaning}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {marksOf(m).length > 0 && (
                      <button
                        className={`mark-chip ${focusMsg === m.id ? 'on' : ''}`}
                        style={{ borderColor: marksOf(m)[0].color, color: marksOf(m)[0].color }}
                        onClick={() => {
                          setFocusMsg(m.id);
                          setView(marksOf(m).some((x) => x.kind === 'part') ? '3d' : 'plan');
                          setWalking(false);
                          setMobileTab('model');
                        }}
                      >
                        <span className="swatch-dot" style={{ background: marksOf(m)[0].color }} />
                        Mark {markNumber(m.id)} · {MARK_COLORS.find((x) => x.c === marksOf(m)[0].color)?.label ?? 'Mark'} · {describeMarks(marksOf(m))}
                      </button>
                    )}
                    {m.erased && <div className="small faint">Marks erased by {m.authorId === me.id ? 'you' : m.authorName}</div>}
                    {canEdit && !m.erased && suggestionCount(marksOf(m)) > 0 && (
                      <button
                        className="btn btn-tonal btn-sm"
                        style={{ marginTop: 6 }}
                        onClick={() => {
                          const edits = suggestionEdits(project.model, marksOf(m));
                          if (!edits.length) return toast('Those suggestions no longer match the plan.', 'error');
                          if (startPreview({ label: `Suggestions from ${m.authorName}`, edits }, { messageId: m.id })) {
                            setView('plan');
                            toast('Previewing the suggestions. Accept the revision to keep them.', 'info');
                          }
                        }}
                      >
                        <Icon name="auto_fix_high" /> Apply {suggestionCount(marksOf(m))} suggested change{suggestionCount(marksOf(m)) === 1 ? '' : 's'}
                      </button>
                    )}
                    {m.anchor && (m.anchor.snapshot || m.anchor.elementIds.length > 0) && (
                      <div className="anchor-card" onClick={() => (focusOn(m.anchor!.elementIds, m.anchor!.view), setMobileTab('model'))}>
                        {m.anchor.snapshot && <img src={m.anchor.snapshot} alt="Pinned view" />}
                        <div className="bar">
                          <Icon name="push_pin" size={14} />
                          {m.anchor.elementIds.map((id) => (
                            <IdTag key={id} id={id} />
                          ))}
                          <span className="grow" />
                          {m.anchor.revision !== project.model.revision && <span className="chip warn" style={{ height: 18 }}>plan changed since</span>}
                        </div>
                      </div>
                    )}
                    {m.proposal && (
                      <div className="card" style={{ marginTop: 8, background: 'var(--surface)', borderColor: 'var(--blue-100)' }}>
                        <div className="card-body" style={{ padding: 10 }}>
                          <div className="row small" style={{ fontWeight: 500 }}>
                            <Icon name="auto_fix_high" size={16} style={{ color: 'var(--blue)' }} /> {m.proposal.label}
                          </div>
                          <div className="small muted">{m.proposal.edits.map((e) => describeEdit(e, project.model)).join(' · ')}</div>
                          {canEdit && (
                            <button className="btn btn-primary btn-sm" style={{ marginTop: 6 }} onClick={() => startPreview(m.proposal!, { messageId: m.id })}>
                              <Icon name="preview" /> Preview in model
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {confirmDelete === m.id ? (
                    <div className="row wrap msg-confirm" style={{ gap: 6, marginTop: 4 }}>
                      <span className="small">Delete this message for everyone?</span>
                      <button className="btn btn-sm btn-danger" onClick={() => void doDelete(m.id)}>
                        <Icon name="delete" /> Delete
                      </button>
                      <button className="btn btn-text btn-sm" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    m.kind !== 'text' &&
                    mine && (
                      <div className="row wrap" style={{ gap: 2, marginTop: 2 }}>
                        <button className="btn btn-text btn-sm" onClick={() => setConfirmDelete(m.id)} title="Delete this message for everyone">
                          <Icon name="delete" /> Delete
                        </button>
                      </div>
                    )
                  )}
                  {m.kind === 'text' && confirmDelete !== m.id && editing?.id !== m.id && (
                    <div className="row wrap" style={{ gap: 2, marginTop: 2 }}>
                      <button
                        className="btn btn-text btn-sm"
                        onClick={() => {
                          setReplyTo(m);
                          setTimeout(() => textRef.current?.focus(), 30);
                        }}
                      >
                        <Icon name="reply" /> Reply
                      </button>
                      {mine && (
                        <button className="btn btn-text btn-sm" onClick={() => setEditing({ id: m.id, text: m.text })} title="Correct your message">
                          <Icon name="edit" /> Edit
                        </button>
                      )}
                      {mine && (
                        <button className="btn btn-text btn-sm" onClick={() => setConfirmDelete(m.id)} title="Delete your message">
                          <Icon name="delete" /> Delete
                        </button>
                      )}
                      {!mine && (m.role === 'client' || m.role === 'lecturer') && (
                        <button className="btn btn-text btn-sm" onClick={() => doIntent(m)} disabled={busy === `intent-${m.id}`} title="Turn feedback into measurable design intents (on-device)">
                          {busy === `intent-${m.id}` ? <Spinner size={14} /> : <Icon name="target" />} Design intent
                        </button>
                      )}
                      {!plainLanguage && (
                        <button className="btn btn-text btn-sm" onClick={() => doTranslate(m)} disabled={busy === `tr-${m.id}`} title="Rewrite in plain language (on-device)">
                          {busy === `tr-${m.id}` ? <Spinner size={14} /> : <Icon name="translate" />} Plain language
                        </button>
                      )}
                      {/* Only the project owner (who invited everyone) marks feedback as dealt with. */}
                      {m.anchor && isOwner && (
                        <button className="btn btn-text btn-sm" onClick={() => setResolved(m.id, !m.resolved)}>
                          <Icon name={m.resolved ? 'undo' : 'check'} /> {m.resolved ? 'Reopen' : 'Resolve'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {minutes && (
            <div className="card" style={{ borderColor: 'var(--blue-100)' }}>
              <div className="card-body" style={{ padding: 14 }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <Icon name="summarize" style={{ color: 'var(--blue)' }} />
                  <b className="grow">Crit minutes</b>
                  <SourceChip source={minutes.source} />
                </div>
                <div className="small">{minutes.data.summary}</div>
                {minutes.data.decisions.length > 0 && (
                  <>
                    <div className="label" style={{ marginTop: 8 }}>Decisions</div>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {minutes.data.decisions.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </>
                )}
                {minutes.data.actions.length > 0 && (
                  <>
                    <div className="label" style={{ marginTop: 8 }}>Actions</div>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {minutes.data.actions.map((a, i) => (
                        <li key={i}>
                          {a.title} <span className="muted">· {roleLabel(a.owner)} · ~{a.effortHours} h</span> {a.elementIds.map((id) => <IdTag key={id} id={id} />)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {minutes.data.openQuestions.length > 0 && (
                  <>
                    <div className="label" style={{ marginTop: 8 }}>Open questions</div>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {minutes.data.openQuestions.map((q, i) => (
                        <li key={i}>{q}</li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="row wrap minutes-actions" style={{ marginTop: 10 }}>
                  {canEdit && (
                    <button className="btn btn-primary btn-sm" onClick={addActions} disabled={!minutes.data.actions.length}>
                      <Icon name="add_task" /> Add actions to schedule
                    </button>
                  )}
                  <button className="btn btn-outline btn-sm" onClick={postMinutes}>
                    Post to thread
                  </button>
                  <button className="btn btn-text btn-sm" onClick={() => setMinutes(null)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
          {visible.length === 0 && (
            <div className="empty">
              <Icon name="forum" />
              Start the crit: select something in the model, pin your view and ask a question.
            </div>
          )}
        </div>

        <div className="composer">
          {draftProposal && (
            <div className="row small" style={{ marginBottom: 8, background: 'var(--blue-50)', padding: '6px 10px', borderRadius: 8 }}>
              <Icon name="auto_fix_high" size={16} style={{ color: 'var(--blue)' }} />
              <span className="grow">Attached proposal: {draftProposal.label}</span>
              <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setDraftProposal(null)}>
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          <div className="row wrap" style={{ marginBottom: 8, gap: 6 }}>
            <button className={`chip chip-select ${pinView ? 'on' : ''}`} onClick={() => setPinView((v) => !v)} title="Attach the selected elements, camera view and a snapshot">
              <Icon name="push_pin" /> Pin view {pinView && selection.length ? `· ${selection.join(', ')}` : ''}
            </button>
            <button className="chip chip-select" onClick={doPropose} disabled={!text.trim() || busy === 'propose'} title="Turn your message into a structured, validated model edit">
              {busy === 'propose' ? <Spinner size={14} /> : <Icon name="auto_fix_high" />} Attach edit proposal
            </button>
            {canEdit && (
              <button className="chip chip-select" onClick={() => navigate('studio')}>
                <Icon name="open_in_new" /> Studio
              </button>
            )}
          </div>
          {drafts.length > 0 && (
            <div className="row small mark-draft" style={{ borderColor: drafts[drafts.length - 1].color }}>
              <span className="swatch-dot" style={{ background: drafts[drafts.length - 1].color }} />
              <span className="grow">
                {drafts.length} mark{drafts.length === 1 ? '' : 's'} ready: {describeMarks(drafts)}. Write what to work on, then send.
              </span>
              <button className="btn btn-text btn-sm" onClick={() => setDrafts((d) => d.slice(0, -1))} title="Undo the last mark">
                <Icon name="undo" />
              </button>
              <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setDrafts([])} aria-label="Clear all marks">
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {replyTo && (
            <div className="reply-banner">
              <Icon name="reply" size={16} />
              <span className="grow text-ellipsis">
                Replying to <b>{replyTo.authorName}</b>: {replyTo.text}
              </span>
              <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setReplyTo(null)} aria-label="Cancel reply">
                <Icon name="close" size={16} />
              </button>
            </div>
          )}
          {mention && mentionMatches.length > 0 && (
            <div className="mention-list" role="listbox" aria-label="Mention someone">
              {mentionMatches.map((p) => (
                <button
                  key={p.id}
                  role="option"
                  aria-selected={false}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const el = textRef.current;
                    const caret = el?.selectionStart ?? text.length;
                    const next = `${text.slice(0, mention.start)}@${p.name} ${text.slice(caret)}`;
                    setText(next);
                    setMention(null);
                    setTimeout(() => {
                      el?.focus();
                      const pos = mention.start + p.name.length + 2;
                      el?.setSelectionRange(pos, pos);
                    }, 0);
                  }}
                >
                  <Avatar m={p} size={24} />
                  <span>{p.name}</span>
                  <small className="muted">{roleLabelFor(p.role, me.role)}</small>
                </button>
              ))}
            </div>
          )}
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <textarea
              ref={textRef}
              rows={1}
              placeholder={me.role === 'client' ? 'Tell your architect what you think…' : me.role === 'lecturer' ? 'Give feedback and pin it to the model…' : 'Message the crit…'}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                // "@" followed by a few letters right before the caret opens the people list.
                const caret = e.target.selectionStart ?? e.target.value.length;
                const m = e.target.value.slice(0, caret).match(/(^|\s)@([^\s@]{0,20})$/);
                setMention(m ? { query: m[2], start: caret - m[2].length - 1 } : null);
              }}
              onBlur={() => setTimeout(() => setMention(null), 150)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setMention(null);
                  setReplyTo(null);
                }
                if (e.key === 'Enter' && !e.shiftKey && mention && mentionMatches.length) {
                  e.preventDefault();
                  const p = mentionMatches[0];
                  const caret = e.currentTarget.selectionStart ?? text.length;
                  setText(`${text.slice(0, mention.start)}@${p.name} ${text.slice(caret)}`);
                  setMention(null);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="icon-btn on" onClick={send} disabled={!text.trim()} aria-label="Send" style={{ width: 44, height: 44 }}>
              <Icon name="send" />
            </button>
          </div>
        </div>
      </section>
      {profile && people.get(profile) && (
        <Dialog
          title="Profile"
          onClose={() => setProfile(null)}
          actions={
            <button className="btn btn-text" onClick={() => setProfile(null)}>
              Close
            </button>
          }
        >
          {(() => {
            const person = people.get(profile)!;
            const here = profile === me.id ? null : presence[profile];
            const said = messages.filter((x) => x.authorId === profile && x.kind === 'text').length;
            return (
              <div className="col" style={{ alignItems: 'center', gap: 10, textAlign: 'center' }}>
                <Avatar m={person} size={96} />
                <div style={{ fontSize: 18, fontWeight: 500 }}>
                  {person.name}
                  {profile === me.id ? ' (you)' : ''}
                </div>
                <div className="muted">{profile === me.id ? roleLabel(person.role) : roleLabelFor(person.role, me.role)}</div>
                <FigurePreview look={lookFor(person.id, person.figure ?? 'woman', person.look?.top ?? person.color, person.look)} size={110} />
                <div className="row wrap" style={{ gap: 6, justifyContent: 'center' }}>
                  {profile === me.id || here ? (
                    <span className="chip">
                      <span className="dot" style={{ background: here?.away ? '#f9ab00' : '#1e8e3e' }} /> {here?.away ? 'In the room, away' : 'In the room now'}
                    </span>
                  ) : (
                    <span className="chip">
                      <span className="dot" style={{ background: '#9aa0a6' }} /> Not in the room right now
                    </span>
                  )}
                  {here?.walk && <span className="chip blue">Walking through the model</span>}
                  {here?.presenting && <span className="chip blue">Presenting</span>}
                  <span className="chip">
                    {said} message{said === 1 ? '' : 's'} here
                  </span>
                </div>
                {profile !== me.id && (
                  <button
                    className="btn btn-tonal btn-sm"
                    onClick={() => {
                      setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}@${person.name} `);
                      setProfile(null);
                      setTimeout(() => textRef.current?.focus(), 30);
                    }}
                  >
                    <Icon name="alternate_email" /> Mention {person.name.split(' ')[0]}
                  </button>
                )}
              </div>
            );
          })()}
        </Dialog>
      )}
    </div>
  );
}

/** Mark colours carry a meaning, so a glance at the plan shows what needs attention. */
const MARK_COLORS = [
  { c: '#d93025', label: 'Needs work' },
  { c: '#f29900', label: 'Think about this' },
  { c: '#1a73e8', label: 'Question' },
  { c: '#188038', label: 'Works well' },
];

function markCenter(m: PlanMark) {
  const xs = m.points.map((p) => p.x);
  const ys = m.points.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

type PlanToolDef = [MarkTool, string, string, string] | '|';
const PLAN_TOOLS: PlanToolDef[] = [
  ['pin', 'location_on', 'Pin a spot', 'Pin'],
  ['area', 'highlight_alt', 'Highlight an area', 'Area'],
  ['pen', 'draw', 'Draw freehand', 'Draw'],
  ['line', 'horizontal_rule', 'Draw a straight line', 'Line'],
  ['arrow', 'north_east', 'Draw an arrow', 'Arrow'],
  ['text', 'sticky_note_2', 'Place a note', 'Note'],
  '|',
  ['wall', 'fence', 'Suggest a new wall', 'Wall'],
  ['door', 'door_front', 'Suggest a new door', 'Door'],
  ['window', 'window', 'Suggest a new window', 'Window'],
  ['remove', 'block', 'Suggest removing a wall, door or furniture', 'Remove'],
  '|',
  ['eraser', 'ink_eraser', 'Erase marks', 'Erase'],
];

const KIND_WORD: Record<PlanMark['kind'], string> = {
  pin: 'a spot',
  area: 'an area',
  pen: 'a drawing',
  line: 'a line',
  arrow: 'an arrow',
  text: 'a note',
  wall: 'a new wall',
  door: 'a new door',
  window: 'a new window',
  remove: 'something to remove',
  part: 'a highlighted part',
};

function describeMarks(marks: PlanMark[]) {
  const words = [...new Set(marks.map((m) => KIND_WORD[m.kind]))];
  return words.length <= 2 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const suggestionCount = (marks: PlanMark[]) => marks.filter((m) => m.kind === 'wall' || m.kind === 'door' || m.kind === 'window' || m.kind === 'remove').length;

/** Turn suggestion marks into real, validated model edits (applied through the preview). */
function suggestionEdits(model: BuildingModel, marks: PlanMark[]): EditOp[] {
  const edits: EditOp[] = [];
  let m: BuildingModel = model;
  const take = (prefix: string) => {
    const id = nextId(m, prefix);
    // Reserve the id so the next suggestion gets a fresh one.
    m = { ...m, walls: [...m.walls, { id, a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, thickness: 0, height: 0, materialId: '', exterior: false, prov: {} }] };
    return id;
  };
  for (const mk of marks) {
    if (mk.kind === 'wall' && mk.points.length >= 2) {
      edits.push({ op: 'addWall', wall: { id: take('W'), a: mk.points[0], b: mk.points[1], thickness: model.defaults.interiorThickness, height: model.defaults.wallHeight, materialId: 'plaster', exterior: false, prov: { a: 'confirmed', b: 'confirmed' } } });
    } else if ((mk.kind === 'door' || mk.kind === 'window') && mk.elementId) {
      const w = model.walls.find((x) => x.id === mk.elementId);
      if (!w) continue;
      const dir = wallDir(w);
      const offset = Math.round((mk.points[0].x - w.a.x) * dir.x + (mk.points[0].y - w.a.y) * dir.y);
      const width = mk.kind === 'door' ? 900 : 1200;
      if (offset - width / 2 < 100 || offset + width / 2 > wallLength(w) - 100) continue;
      const d = model.defaults;
      edits.push({
        op: 'addOpening',
        opening: mk.kind === 'door' ? { id: take('D'), kind: 'door', wallId: w.id, offset, width, height: d.doorHeight, sill: 0, hinge: 'start', swing: 1, prov: { offset: 'confirmed' } } : { id: take('N'), kind: 'window', wallId: w.id, offset, width, height: d.windowHead - d.windowSill, sill: d.windowSill, hinge: 'start', swing: 1, prov: { offset: 'confirmed' } },
      });
    } else if (mk.kind === 'remove' && mk.elementId) {
      const id = mk.elementId;
      if (model.walls.some((w) => w.id === id)) edits.push({ op: 'removeWall', wallId: id });
      else if (model.openings.some((o) => o.id === id)) edits.push({ op: 'removeOpening', openingId: id });
      else if (model.furniture.some((f) => f.id === id)) edits.push({ op: 'removeFurniture', furnitureId: id });
    }
  }
  return edits;
}

/** Message text with @mentions highlighted (yours stand out more). */
function withMentions(text: string, people: { id: string; name: string }[], meId: string) {
  const names = people.filter((p) => p.name).sort((a, b) => b.name.length - a.name.length);
  if (!names.length || !text.includes('@')) return text;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`@(${names.map((p) => esc(p.name)).join('|')})`, 'g');
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const who = names.find((p) => p.name === m[1]);
    out.push(text.slice(last, m.index));
    out.push(
      <span key={m.index} className={`mention ${who?.id === meId ? 'me' : ''}`}>
        @{m[1]}
      </span>,
    );
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
