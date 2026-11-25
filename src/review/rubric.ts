/**
 * Measured evidence for each rubric criterion. Used on its own when the AI is unavailable,
 * and to fill in the evidence line when the AI's answer leaves it out. Every sentence here
 * comes from the model or the project history, never from a guess.
 */
import { derive } from '../model/derive';
import type { Brief, BuildingModel, Finding, Id, Revision, RubricCriterion } from '../model/types';

export interface CriterionReview {
  criterionId: Id;
  score: number;
  strengths: string;
  improvement: string;
  /** Plain-language measurements behind the score. */
  evidence: string;
  elementIds: Id[];
}

export interface ReviewContext {
  revisions?: Revision[];
}

type Topic = 'brief' | 'circulation' | 'concept' | 'rationale' | 'drawing' | 'presentation' | 'daylight' | 'access' | 'overall';

export function topicOf(c: RubricCriterion): Topic {
  const t = `${c.name} ${c.description}`.toLowerCase();
  if (/daylight|light|sun|environment|sustain|energy/.test(t)) return 'daylight';
  if (/access|inclusive|wheelchair/.test(t)) return 'access';
  if (/circulation|spatial|zoning|movement|layout|relationship/.test(t)) return 'circulation';
  if (/brief|requirement|accommodation|programme|program|client/.test(t)) return 'brief';
  if (/rationale|decision|justif|explain/.test(t)) return 'rationale';
  if (/concept|idea|iteration|develop/.test(t)) return 'concept';
  if (/drawing|complete|technical|dimension|document/.test(t)) return 'drawing';
  if (/present|board|communicat|graphic/.test(t)) return 'presentation';
  return 'overall';
}

const m2 = (a: number) => `${a.toFixed(1)} m²`;
const clamp = (n: number) => Math.max(35, Math.min(94, Math.round(n)));
const list = (xs: string[], max = 3) => (xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function reviewCriterion(model: BuildingModel, brief: Brief, findings: Finding[], c: RubricCriterion, ctx: ReviewContext = {}): CriterionReview {
  const d = derive(model);
  const open = findings.filter((f) => f.status === 'open');
  const resolved = findings.filter((f) => f.status === 'resolved');
  const of = (...cats: string[]) => open.filter((f) => cats.includes(f.category));
  const weight = (fs: Finding[]) => fs.reduce((s, f) => s + (f.severity === 'critical' ? 14 : f.severity === 'warning' ? 9 : f.severity === 'advice' ? 5 : 2), 0);
  const ids = (fs: Finding[]) => [...new Set(fs.flatMap((f) => f.evidence.elementIds))].slice(0, 6);
  const rooms = d.rooms;
  const total = rooms.reduce((s, r) => s + r.area, 0);
  const doors = model.openings.filter((o) => o.kind === 'door' || o.kind === 'opening');
  const windows = model.openings.filter((o) => o.kind === 'window');
  const storeys = model.levels?.length ?? 1;
  const out = (score: number, strengths: string, improvement: string, evidence: string, elementIds: Id[]): CriterionReview => ({ criterionId: c.id, score: clamp(score), strengths, improvement, evidence, elementIds });

  switch (topicOf(c)) {
    case 'brief': {
      const met: { text: string; id: Id }[] = [];
      const short: { text: string; id?: Id }[] = [];
      const missing: string[] = [];
      for (const q of brief.requirements) {
        const pool = rooms.filter((r) => r.type === q.type).sort((a, b) => b.area - a.area);
        for (let i = 0; i < q.count; i++) {
          const r = pool[i];
          const label = q.count > 1 ? `${q.label} ${i + 1}` : q.label;
          if (!r) missing.push(label);
          else if (r.area + 0.05 < q.minArea) short.push({ text: `${r.name} ${m2(r.area)} (target ${m2(q.minArea)})`, id: r.id });
          else met.push({ text: `${r.name} ${m2(r.area)}`, id: r.id });
        }
      }
      const needed = met.length + short.length + missing.length;
      const fs = of('brief');
      const score = needed ? 52 + (met.length / needed) * 40 - missing.length * 6 - weight(fs) * 0.4 : 70;
      return out(
        score,
        needed ? `${met.length} of ${needed} required spaces meet their area targets${met.length ? `, for example ${list(met.map((x) => x.text), 2)}` : ''}.` : `${rooms.length} spaces planned across ${m2(total)}.`,
        missing.length ? `Add the missing ${list(missing)}.` : short.length ? `Enlarge ${list(short.map((s) => s.text), 2)}.` : fs[0]?.suggestion ?? 'Check the client notes again and show how each need is met on your boards.',
        needed ? `Met: ${met.length}. Undersized: ${short.length ? list(short.map((s) => s.text)) : 'none'}. Missing: ${missing.length ? list(missing) : 'none'}. Total floor area ${m2(total)}.` : `${rooms.length} rooms, ${m2(total)} in total. The brief lists no area targets.`,
        [...short.map((s) => s.id).filter((x): x is Id => !!x), ...ids(fs), ...met.slice(0, 3).map((x) => x.id)].slice(0, 6),
      );
    }
    case 'circulation': {
      // Rooms reachable from the front door through doors and open openings.
      const entry = doors.find((o) => {
        const l = d.links.get(o.id);
        return l && (!l.plus || !l.minus);
      });
      const l = entry ? d.links.get(entry.id) : undefined;
      const start = l?.plus ?? l?.minus ?? rooms[0]?.id;
      const seen = new Set<Id>();
      const queue = start ? [start] : [];
      while (queue.length) {
        const r = queue.shift()!;
        if (seen.has(r)) continue;
        seen.add(r);
        for (const n of d.connections.get(r) ?? []) if (!seen.has(n)) queue.push(n);
      }
      const cut = rooms.filter((r) => !seen.has(r.id));
      const hall = rooms.filter((r) => r.type === 'hall').reduce((s, r) => s + r.area, 0);
      const share = total ? (hall / total) * 100 : 0;
      const fs = of('circulation', 'privacy', 'clearance');
      const score = 82 - cut.length * 9 - weight(fs) * 0.8 - (share > 22 ? 6 : 0) - (!entry ? 8 : 0);
      return out(
        score,
        cut.length ? `${seen.size} of ${rooms.length} rooms link up through ${plural(doors.length, 'door')}.` : `Every room can be reached from ${entry ? 'the entrance' : 'the first room'} through ${plural(doors.length, 'door')}${hall ? `, with circulation at ${share.toFixed(0)}% of the floor area` : ''}.`,
        cut.length ? `Add doors so ${list(cut.map((r) => r.name))} can be reached.` : fs[0]?.suggestion ?? (share > 22 ? `Circulation takes ${share.toFixed(0)}% of the plan; tighten the hall to give that area back to rooms.` : 'Show the movement route and public to private zoning on a diagram.'),
        `${plural(doors.length, 'door')}; ${seen.size}/${rooms.length} rooms reachable${entry ? ' from the entrance' : ' (no outside door found)'}; hall space ${m2(hall)} (${share.toFixed(0)}%); ${plural(fs.length, 'open circulation or clearance finding')}.`,
        [...cut.map((r) => r.id), ...ids(fs), ...(entry ? [entry.id] : []), ...rooms.filter((r) => r.type === 'hall').map((r) => r.id)].slice(0, 6),
      );
    }
    case 'daylight': {
      const lit = new Map<Id, number>();
      for (const w of windows) {
        const link = d.links.get(w.id);
        const r = link?.plus ?? link?.minus;
        if (r) lit.set(r, (lit.get(r) ?? 0) + (w.width * w.height) / 1e6);
      }
      const habitable = rooms.filter((r) => ['bedroom', 'living', 'kitchen', 'dining', 'study'].includes(r.type));
      const dim = habitable.filter((r) => (lit.get(r.id) ?? 0) / Math.max(r.area, 0.1) < 0.1);
      const fs = of('daylight');
      return out(
        84 - dim.length * 8 - weight(fs) * 0.6,
        `${habitable.length - dim.length} of ${habitable.length} habitable rooms have glazing of at least 10% of their floor area.`,
        dim.length ? `Add or widen windows in ${list(dim.map((r) => r.name))}.` : fs[0]?.suggestion ?? 'Show sun paths on the site plan to explain the window positions.',
        `${plural(windows.length, 'window')}. Below 10% glazing: ${dim.length ? list(dim.map((r) => `${r.name} ${(((lit.get(r.id) ?? 0) / Math.max(r.area, 0.1)) * 100).toFixed(0)}%`)) : 'none'}.`,
        [...dim.map((r) => r.id), ...ids(fs)].slice(0, 6),
      );
    }
    case 'access': {
      const narrow = model.openings.filter((o) => o.kind === 'door' && o.width < 800);
      const fs = of('accessibility', 'clearance');
      return out(
        84 - narrow.length * 6 - weight(fs) * 0.7,
        `${doors.length - narrow.length} of ${doors.length} doorways are at least 800 mm wide.`,
        narrow.length ? `Widen ${plural(narrow.length, 'door')} to 800 mm or more.` : fs[0]?.suggestion ?? 'Mark turning circles in the bathroom and kitchen to show they work.',
        `Narrow doors (under 800 mm): ${narrow.length ? list(narrow.map((o) => `${o.width} mm`)) : 'none'}; ${plural(fs.length, 'open accessibility finding')}.`,
        [...narrow.map((o) => o.id), ...ids(fs)].slice(0, 6),
      );
    }
    case 'concept': {
      const revs = ctx.revisions ?? [];
      const labels = revs.slice(-3).map((r) => `“${r.label}”`);
      const form = model.spec ? `${model.spec.type}, ${plural(model.spec.storeys, 'storey')}` : storeys > 1 ? plural(storeys, 'storey') : 'single storey';
      const fs = of('concept');
      return out(
        58 + Math.min(revs.length, 6) * 5 + (resolved.length ? 4 : 0) - weight(fs) * 0.5,
        revs.length ? `The design has moved through ${plural(revs.length, 'saved revision')}, most recently ${list(labels, 2)}.` : `A ${form} scheme with ${rooms.length} spaces is in place.`,
        revs.length < 3 ? 'Save a revision at each design step so the development of the idea is visible.' : fs[0]?.suggestion ?? 'Put the concept diagram next to the plan so the idea reads at a glance.',
        `${plural(revs.length, 'revision')} saved${labels.length ? ` (latest ${list(labels, 3)})` : ''}; form: ${form}; ${plural(resolved.length, 'finding')} resolved through changes.`,
        ids(fs),
      );
    }
    case 'rationale': {
      const revs = ctx.revisions ?? [];
      const linked = revs.filter((r) => r.findingIds.length > 0);
      return out(
        56 + Math.min(resolved.length, 6) * 4 + Math.min(linked.length, 4) * 4,
        resolved.length ? `${plural(resolved.length, 'review finding')} closed with a recorded change.` : `${rooms.length} rooms with measured areas give the rationale real numbers to quote.`,
        linked.length ? 'Quote the measured results (areas, glazing, routes) in the written rationale.' : 'Link each revision to the finding it answers, then draft the rationale from them.',
        `${plural(resolved.length, 'finding')} resolved, ${open.length} still open; ${linked.length} of ${plural(revs.length, 'revision')} linked to findings.`,
        [],
      );
    }
    case 'drawing': {
      const unnamed = rooms.filter((r) => !r.name.trim() || /^room\s*\d*$/i.test(r.name));
      const fs = of('geometry');
      return out(
        86 - d.unenclosed.length * 8 - unnamed.length * 4 - weight(fs) * 0.8,
        `${plural(model.walls.length, 'wall')}, ${plural(model.openings.length, 'opening')} and ${plural(rooms.length, 'room')} drawn${storeys > 1 ? ` over ${storeys} floors` : ''}${d.unenclosed.length ? '' : ', every room fully enclosed'}.`,
        d.unenclosed.length ? `Close the walls around ${plural(d.unenclosed.length, 'room')} so it has a measurable area.` : unnamed.length ? `Name ${list(unnamed.map((r) => r.name || 'unnamed room'))}.` : fs[0]?.suggestion ?? 'Add a section and dimension strings to complete the set.',
        `Rooms not enclosed: ${d.unenclosed.length}; unnamed rooms: ${unnamed.length}; ${plural(fs.length, 'open geometry finding')}; ${plural(model.furniture.length, 'furniture item')} placed.`,
        [...d.unenclosed, ...unnamed.map((r) => r.id), ...ids(fs)].slice(0, 6),
      );
    }
    case 'presentation': {
      const furnished = new Set(model.furniture.map((f) => d.roomAt({ x: f.x, y: f.y })?.id).filter(Boolean));
      const empty = rooms.filter((r) => !furnished.has(r.id) && r.type !== 'hall');
      const fs = of('presentation');
      return out(
        80 - Math.min(empty.length, 5) * 4 - weight(fs) * 0.6,
        `${rooms.length - empty.length} of ${rooms.length} rooms are furnished, so the plan and 3D views read as lived-in spaces.`,
        empty.length ? `Furnish ${list(empty.map((r) => r.name))} before exporting views for your boards.` : fs[0]?.suggestion ?? 'Export a walkthrough still for each key space to put on your boards.',
        `${plural(model.furniture.length, 'furniture item')}; unfurnished rooms: ${empty.length ? list(empty.map((r) => r.name)) : 'none'}; roof: ${!model.roof || model.roof.kind === 'none' ? 'not modelled yet' : model.roof.kind}.`,
        empty.map((r) => r.id).slice(0, 6),
      );
    }
    default: {
      const fs = open;
      return out(
        80 - weight(fs) * 0.3,
        `${rooms.length} spaces across ${m2(total)}${storeys > 1 ? ` on ${storeys} floors` : ''}.`,
        fs[0]?.suggestion ?? 'Explain how the plan answers this criterion on your boards.',
        `${plural(fs.length, 'open finding')} (${fs.filter((f) => f.severity === 'warning' || f.severity === 'critical').length} serious); ${plural(resolved.length, 'resolved')}.`,
        ids(fs),
      );
    }
  }
}
