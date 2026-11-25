import { useEffect, useState, type ReactNode } from 'react';
import type { AISource, Id, Member, Provenance } from '../model/types';
import { sourceLabel } from '../ai/hybrid';
import { useStudio } from '../state/store';
import { navigate } from './router';
import { usePhoto } from './profiles';

export function Icon({ name, fill, className = '', size, style }: { name: string; fill?: boolean; className?: string; size?: number; style?: React.CSSProperties }) {
  return (
    <span className={`ms ${fill ? 'fill' : ''} ${className}`} style={{ ...(size ? { fontSize: size } : {}), ...style }} aria-hidden>
      {name}
    </span>
  );
}

export function SourceChip({ source, compact }: { source: AISource | 'blocked' | 'error'; compact?: boolean }) {
  const icon = source === 'on_device' ? 'laptop_chromebook' : source === 'in_cloud' ? 'cloud' : source === 'blocked' ? 'block' : source === 'error' ? 'error' : 'function';
  const cls = source === 'on_device' ? 'device' : source === 'in_cloud' ? 'cloud' : source;
  return (
    <span className={`chip ${cls}`} title={`Inference: ${sourceLabel(source)}`}>
      <Icon name={icon} />
      {!compact && sourceLabel(source)}
    </span>
  );
}

export function ProvBadge({ p }: { p?: Provenance }) {
  if (!p) return null;
  return <span className={`prov ${p}`}>{p}</span>;
}

export function IdTag({ id }: { id: Id }) {
  const focusOn = useStudio((s) => s.focusOn);
  return (
    <span
      className="idtag"
      title="Show in model"
      onClick={(e) => {
        e.stopPropagation();
        focusOn([id]);
        if (!location.hash.startsWith('#/studio') && !location.hash.startsWith('#/crit')) navigate('studio');
      }}
    >
      {id}
    </span>
  );
}

export function Avatar({ m, size = 32 }: { m: Pick<Member, 'name' | 'color'> & { id?: string; photo?: string }; size?: number }) {
  // The person's current photo (their profile), not the copy saved when they joined a project.
  const photo = usePhoto(m.id, m.photo);
  if (photo) return <img className="avatar avatar-photo" src={photo} alt={m.name} title={m.name} width={size} height={size} referrerPolicy="no-referrer" style={{ width: size, height: size }} />;
  const initials = m.name
    .replace(/^(Prof\.|Dr\.|The)\s+/i, '')
    .split(/\s+/)
    .map((s) => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="avatar" style={{ background: m.color, width: size, height: size, fontSize: size * 0.4 }} title={m.name}>
      {initials}
    </span>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

export function Dialog({ title, children, actions, onClose }: { title: string; children: ReactNode; actions?: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <div className="body">{children}</div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, icon, actions, tabs }: { title: string; subtitle?: ReactNode; icon?: string; actions?: ReactNode; tabs?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="title-row">
        {icon && <Icon name={icon} size={26} style={{ color: 'var(--text-2)' }} />}
        <h1>{title}</h1>
        <div className="grow" />
        {actions}
      </div>
      {subtitle && <div className="subtitle">{subtitle}</div>}
      {tabs ? <div className="tabs">{tabs}</div> : <div style={{ height: 8 }} />}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <Icon name="progress_activity" className="spin" size={size} />;
}

export function useNow(ms = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function timeAgo(t: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export const fmtDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
