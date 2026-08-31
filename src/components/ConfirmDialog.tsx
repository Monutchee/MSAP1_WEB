import {
  useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import './confirmDialog.css'

export interface ConfirmDialogState {
  title: string
  description: string
  confirmLabel: string
  detail?: string
}

export function ConfirmDialog({ state, busy, error, onCancel, onConfirm }: {
  state: ConfirmDialogState | undefined
  busy: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!state) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.focus()
    return () => { document.body.style.overflow = previousOverflow }
  }, [state])

  if (!state) return null

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy) onCancel()
      return
    }
    if (event.key !== 'Tab') return
    const controls = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>(
      'button:not(:disabled)',
    ) ?? [])
    if (controls.length === 0) {
      event.preventDefault()
      return
    }
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (event.shiftKey &&
        (document.activeElement === first || document.activeElement === panel.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return <div className="confirm-dialog-backdrop">
    <section ref={panel} tabIndex={-1} className="confirm-dialog"
      role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-description" aria-busy={busy}
      onKeyDown={handleKeyDown}>
      <p className="eyebrow">Confirm deletion</p>
      <h2 id="confirm-dialog-title">{state.title}</h2>
      <p id="confirm-dialog-description">{state.description}</p>
      {state.detail && <code>{state.detail}</code>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="confirm-dialog-actions">
        <button type="button" className="secondary" disabled={busy}
          onClick={onCancel}>Cancel</button>
        <button type="button" className="danger" disabled={busy}
          onClick={onConfirm}>{busy ? 'Deleting…' : state.confirmLabel}</button>
      </div>
    </section>
  </div>
}
