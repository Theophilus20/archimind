import { useMemo } from 'react';
import { useStudio } from '../state/store';
import { useCollab } from '../collab/collab';
import { navigate } from '../ui/router';
import type { Pin } from './Plan2D';

/** Finding and crit-comment pins shown in both the plan and the 3D view. */
export function usePins(opts: { findings?: boolean; messages?: boolean; onMessage?: (id: string) => void } = {}) {
  const findings = useStudio((s) => s.project.findings);
  const messages = useCollab((s) => s.messages);
  const focusOn = useStudio((s) => s.focusOn);
  return useMemo(() => {
    const pins: Pin[] = [];
    if (opts.findings !== false)
      for (const f of findings) {
        if (f.status !== 'open' || !f.evidence.elementIds.length) continue;
        if (f.severity === 'info') continue;
        pins.push({
          id: `f-${f.id}`,
          elementId: f.evidence.elementIds[0],
          label: f.title,
          kind: 'finding',
          tone: f.severity === 'critical' ? 'critical' : f.severity === 'warning' ? 'warning' : 'advice',
          onClick: () => navigate('review', { finding: f.id }),
        });
      }
    if (opts.messages !== false)
      for (const m of messages) {
        if (m.resolved || !m.anchor?.elementIds.length || m.kind !== 'text' || m.anchor.mark) continue;
        pins.push({
          id: `m-${m.id}`,
          elementId: m.anchor.elementIds[0],
          label: `${m.authorName}: ${m.text}`,
          kind: 'message',
          tone: 'message',
          onClick: () => {
            if (opts.onMessage) opts.onMessage(m.id);
            else navigate('crit', { message: m.id });
            focusOn(m.anchor!.elementIds, m.anchor!.view);
          },
        });
      }
    return pins;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findings, messages, opts.findings, opts.messages]);
}
