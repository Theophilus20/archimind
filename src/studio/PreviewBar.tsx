import { useStudio } from '../state/store';
import { useMyAccess } from '../firebase/access';
import { describeEdit } from '../model/edits';
import { Icon } from '../ui/common';

export function PreviewBar() {
  const preview = useStudio((s) => s.preview);
  const model = useStudio((s) => s.project.model);
  const accept = useStudio((s) => s.acceptPreview);
  const cancel = useStudio((s) => s.cancelPreview);
  const canAccept = useMyAccess() === 'full';
  if (!preview) return null;
  return (
    <div className="preview-bar" role="region" aria-label="Proposal preview">
      <Icon name="preview" style={{ color: '#81c995' }} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Previewing: {preview.proposal.label}</div>
        <div className="small" style={{ color: '#bdc1c6', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {preview.proposal.edits.map((e) => describeEdit(e, model)).join(' · ')} · geometry validated
          {preview.issues.length ? ` · ${preview.issues.length} warning(s)` : ''}
        </div>
      </div>
      <button className="btn btn-text" onClick={cancel}>
        Discard
      </button>
      {canAccept && (
        <button className="btn btn-primary" onClick={accept} style={{ borderRadius: 20 }}>
          <Icon name="check" /> Accept revision
        </button>
      )}
    </div>
  );
}
