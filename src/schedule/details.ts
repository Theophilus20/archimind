/**
 * Written details for tasks ArchiMind creates (from the brief, a review finding, a revision or
 * a crit), so the schedule says what to actually do. Only tasks added by hand start empty.
 * Everything here comes from the project itself: the brief, the model, findings and messages.
 */
import { derive } from '../model/derive';
import type { Brief, BuildingModel, Finding, Milestone, Task } from '../model/types';

export interface DetailsContext {
  brief: Brief;
  model: BuildingModel;
  findings: Finding[];
  milestones: Milestone[];
}

const fmt = (iso?: string) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const lines = (...xs: (string | false | undefined | null)[]) => xs.filter(Boolean).join('\n');
const bullets = (xs: string[]) => xs.map((x) => `• ${x}`).join('\n');

function requirementsList(brief: Brief) {
  return brief.requirements.map((q) => `${q.count > 1 ? `${q.count} × ` : ''}${q.label} (at least ${q.minArea} m²${q.count > 1 ? ' each' : ''})`);
}

/** Steps for the standard brief tasks, matched by what the task is about. */
function briefSteps(t: Task, c: DetailsContext): string {
  const { brief, model, milestones } = c;
  const title = t.title.toLowerCase();
  const crit = milestones.find((m) => m.kind === 'review');
  const rooms = derive(model).rooms;
  const storeys = model.levels?.length ?? 1;
  const kind = model.spec ? model.spec.type : 'design';
  const goals = brief.goals.length ? brief.goals.join(', ') : '';

  if (/concept|precedent/.test(title))
    return lines(
      `Find the big idea for the ${kind} before drawing plans.`,
      bullets([
        `Collect 3 to 5 precedents that deal with ${goals || 'similar briefs'}; note one lesson from each.`,
        `Write the concept in one sentence that answers the client: ${brief.client || 'see the brief'}.`,
        'Sketch 2 or 3 quick zoning options (public, private, service) on the site and pick one.',
        `Site is ${brief.siteWidth} × ${brief.siteDepth} m; mark north, the street and the best view.`,
      ]),
    );
  if (/floor plan|plan/.test(title) && !/presentation/.test(title))
    return lines(
      `Lay out every required space${storeys > 1 ? ` across ${storeys} floors` : ''}:`,
      bullets(requirementsList(brief)),
      'Then check:',
      bullets([
        'Every room is reachable from the entrance without passing through a bedroom.',
        'Door swings clear the furniture; run Design review and fix the measured issues.',
        brief.notes ? `Client notes: ${brief.notes}` : 'Re-read the client notes in the brief.',
      ]),
      `Now: ${rooms.length} spaces drawn.`,
    );
  if (/interim|crit/.test(title))
    return lines(
      `Get ready for the interim crit${crit ? ` on ${fmt(crit.date)}` : ''}.`,
      bullets([
        'Pin up the concept sketch, the current floor plan and one 3D view.',
        'Save a revision so the crit comments attach to this version.',
        'Write down 2 or 3 questions you want feedback on.',
        'Open the Crit room and share the link with your lecturer or classmates.',
      ]),
    );
  if (/section/.test(title))
    return lines(
      'Draw two sections that explain the heights and the light.',
      bullets([
        'A–A: the long cut through the main living space and the entrance.',
        'B–B: the short cut through a bedroom and the bathroom.',
        `Show floor-to-ceiling heights (walls are ${(model.defaults?.wallHeight ?? 2700) / 1000} m), the roof build-up and the ground line.`,
        'Add people for scale and label every room.',
      ]),
    );
  if (/3d|view|model/.test(title))
    return lines(
      'Finish the 3D model and save views for the boards.',
      bullets([
        'Set the roof and materials in the Studio.',
        'Save 3 views: the street approach, the main living space and one private room.',
        'Use Walk through to check how the spaces feel at eye level.',
      ]),
    );
  if (/material/.test(title))
    return lines(
      'Choose and show the material palette.',
      bullets(['Floors, walls, roof and window frames: one sample each with its name.', 'Say why each material suits the concept (warmth, light, durability, cost).', 'Keep it to 6 to 8 materials so the board reads clearly.']),
    );
  if (/rationale/.test(title))
    return lines(
      'Explain the main design decisions with evidence.',
      bullets([
        'Open Revisions and use Draft rationale as a starting point.',
        'For each decision, quote the measurement behind it (room areas, daylight, routes).',
        'Mention the crit feedback you acted on and what changed.',
        'Keep it to about 300 words.',
      ]),
    );
  if (/board|presentation/.test(title))
    return lines(
      `Compose the final boards${brief.deadline ? ` for ${fmt(brief.deadline)}` : ''}.`,
      bullets([
        'Concept and precedents, floor plan, sections A–A and B–B, 3D views, material board, rationale.',
        'Use one clear reading order (left to right, top to bottom) and consistent titles.',
        `Check them against the rubric: ${brief.rubric.map((r) => `${r.name} ${r.weight}%`).join(', ') || 'see the brief'}.`,
      ]),
    );
  if (/export|submit/.test(title))
    return lines(
      `Submit by ${fmt(brief.deadline) || 'the deadline'}.`,
      bullets(['Export the boards as PDF and check every page.', 'Name the files as your lecturer asked.', 'Upload, then confirm the submission went through.']),
    );
  return lines(t.deliverable ? `Produce: ${t.deliverable}.` : '', 'See the brief for what is needed.');
}

/** Draft details for a task. Manual tasks return '' because the person writes their own. */
export function draftTaskDetails(t: Task, c: DetailsContext, extra?: { crit?: string; askedBy?: string }): string {
  switch (t.origin) {
    case 'brief':
      return briefSteps(t, c);
    case 'finding': {
      const f = c.findings.find((x) => t.links.findingIds.includes(x.id));
      if (!f) return lines('Resolve the review finding this task came from.', 'Open Design review to see it.');
      return lines(
        `Problem: ${f.finding}`,
        f.suggestion && `What to do: ${f.suggestion}`,
        f.evidence.text && `Measured: ${f.evidence.text}`,
        f.evidence.elementIds.length > 0 && `Elements: ${f.evidence.elementIds.join(', ')}`,
        'Done when: Design review no longer lists this issue.',
      );
    }
    case 'revision': {
      const ids = [...new Set(t.links.elementIds)];
      const what: Record<string, string> = {
        'Floor plan': 'Update dimensions, door and window tags and room labels on the plan.',
        Sections: 'Re-draw the section lines that cross the moved walls and check the heights still match.',
        'Area schedule': 'Re-measure the room areas and update the table on your boards.',
        Elevations: 'Redraw the elevations where windows or outside walls changed.',
        'Furnished plan': 'Move the furniture on the plan so it matches the model.',
        '3D views': 'Re-save the 3D views so the boards show the current design.',
      };
      return lines(
        `Revision ${t.links.revision ?? ''} changed ${ids.length ? ids.join(', ') : 'the model'}. Bring the ${t.deliverable ?? 'drawings'} up to date.`,
        t.deliverable && what[t.deliverable] ? `What to do: ${what[t.deliverable]}` : '',
        'Done when: the drawing matches the model in the Studio.',
      );
    }
    case 'message':
      return lines(
        extra?.askedBy ? `From the crit (${extra.askedBy}): ${t.title}` : `From the crit: ${t.title}`,
        extra?.crit && `Crit summary: ${extra.crit}`,
        t.links.elementIds.length > 0 && `Elements discussed: ${t.links.elementIds.join(', ')}`,
        'Done when: you can show the change at the next crit.',
      );
    case 'ai':
      return lines(`Drafted by AI: ${t.title}.`, t.deliverable ? `Produce: ${t.deliverable}.` : '');
    default:
      return '';
  }
}

/** Fill in details for generated tasks that don't have any yet. */
export function withDetails(tasks: Task[], c: DetailsContext, extra?: { crit?: string; askedBy?: string }): Task[] {
  return tasks.map((t) => (t.notes || t.origin === 'manual' ? t : { ...t, notes: draftTaskDetails(t, c, extra) || undefined }));
}
