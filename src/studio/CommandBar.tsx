/**
 * Command line and status bar under the plan: what you type, suggestions,
 * the current prompt, and the OSNAP / GRID / ORTHO / SNAP toggles (F3, F7, F8, F9).
 */
import { AIDS, useAids } from './aids';
import { COMMANDS, SHORTCUTS, suggest } from './commands';
import { Dialog, Icon } from '../ui/common';

export function CommandBar({ buffer, message, onPick, onHelp }: { buffer: string; message: string; onPick: (alias: string) => void; onHelp: () => void }) {
  const aids = useAids();
  const toggle = useAids((s) => s.toggle);
  const setStyle = useAids((s) => s.setStyle);
  const hints = suggest(buffer);
  return (
    <div className="cmd-bar" role="region" aria-label="Command line and drawing aids">
      {hints.length > 0 && (
        <div className="cmd-suggest" role="listbox" aria-label="Matching commands">
          {hints.map((c) => (
            <button key={c.names[0]} role="option" aria-selected={false} onMouseDown={(e) => (e.preventDefault(), onPick(c.names[0]))}>
              <b>{c.names[0]}</b> {c.label}
              <span className="faint"> {c.names.slice(1, 4).join(', ')}</span>
            </button>
          ))}
        </div>
      )}
      <div className="cmd-line">
        <span className="cmd-prompt">Command:</span>
        <span className="cmd-buffer">
          {buffer}
          <span className="cmd-caret" />
        </span>
        <span className="cmd-message">{!buffer && message}</span>
      </div>
      <div className="cmd-aids">
        {AIDS.map((a) => (
          <button key={a.key} className={`cmd-aid ${aids[a.key] ? 'on' : ''}`} onClick={() => toggle(a.key)} title={a.fkey ? `${a.hint} (${a.fkey})` : a.hint} aria-pressed={aids[a.key]}>
            {a.label}
          </button>
        ))}
        <button className="cmd-aid" onClick={() => setStyle(aids.planStyle === 'colour' ? 'drawing' : 'colour')} title={aids.planStyle === 'colour' ? 'Show as a construction drawing (black walls, white rooms, dimensions)' : 'Show rooms in colour'}>
          {aids.planStyle === 'colour' ? 'COLOUR' : 'DRAWING'}
        </button>
        <button className="cmd-aid" onClick={onHelp} title="Shortcuts and commands (F1)" aria-label="Shortcuts and commands">
          <Icon name="keyboard" size={16} />
        </button>
      </div>
    </div>
  );
}

export function CommandHelp({ onClose }: { onClose: () => void }) {
  const groups = ['Draw', 'Modify', 'Measure', 'Select and view'] as const;
  return (
    <Dialog
      title="Commands and shortcuts"
      onClose={onClose}
      actions={
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="cmd-help">
        <p className="small muted" style={{ marginTop: 0 }}>
          Type a command (short names common to drafting programs) and press Enter or Space. Enter on its own repeats the last command.
        </p>
        {groups.map((g) => (
          <div key={g}>
            <div className="label">{g}</div>
            <table className="table cmd-table">
              <tbody>
                {COMMANDS.filter((c) => c.group === g).map((c) => (
                  <tr key={c.names[0]}>
                    <td>
                      {c.names.map((n) => (
                        <kbd key={n}>{n}</kbd>
                      ))}
                    </td>
                    <td>{c.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <div className="label">Keys and mouse</div>
        <table className="table cmd-table">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">On a phone or tablet: tap to select, tap Erase then tap things to delete them, drag with one finger to move around, and pinch to zoom.</p>
      </div>
    </Dialog>
  );
}
