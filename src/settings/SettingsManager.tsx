import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, SettingsDiff, SettingsDocument, SettingsRevision } from '../api'
import './settings.css'

interface SettingsManagerProps {
  view: 'changes' | 'history'
  onUnauthorized: () => void
  onDirtyChange: (dirty: boolean) => void
}

/**
 * Settings revision UI. Typed configuration forms remain focused on their
 * domains; this component owns the global draft, diff, commit, and restore
 * workflow shared by every settings section.
 */
export function SettingsManager({ view, onUnauthorized, onDirtyChange }: SettingsManagerProps) {
  const [draft, setDraft] = useState<SettingsDocument>()
  const [diff, setDiff] = useState<SettingsDiff>()
  const [history, setHistory] = useState<SettingsRevision[]>([])
  const [message, setMessage] = useState('settings update')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const handleError = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return
    }
    setError(reason instanceof Error ? reason.message : 'Settings request failed')
  }, [onUnauthorized])

  const refresh = useCallback(async () => {
    try {
      const [nextDraft, nextDiff, nextHistory] = await Promise.all([
        api.draftSettings(), api.settingsDiff(), api.settingsHistory(),
      ])
      setDraft(nextDraft)
      setDiff(nextDiff)
      setHistory(nextHistory.revisions)
      onDirtyChange(nextDiff.dirty)
      setError('')
    } catch (reason) { handleError(reason) }
  }, [handleError, onDirtyChange])

  useEffect(() => { void refresh() }, [refresh])

  async function execute(action: () => Promise<unknown>, success: string) {
    setBusy(true)
    setError('')
    setStatus('Applying…')
    try {
      await action()
      setStatus(success)
      await refresh()
    } catch (reason) {
      setStatus('')
      handleError(reason)
    } finally { setBusy(false) }
  }

  async function commit() {
    if (!draft || !diff?.dirty) return
    await execute(() => api.commitSettings(draft, message), 'Committed and hot-applied')
  }

  async function discard() {
    await execute(() => api.discardSettings(), 'Draft discarded')
  }

  async function restore(revision: number) {
    await execute(() => api.restoreSettings(revision), `Revision ${revision} restored to draft`)
  }

  async function factoryReset() {
    if (!confirmReset) {
      setConfirmReset(true)
      setStatus('Select Factory reset again to confirm.')
      return
    }
    await execute(() => api.factoryResetSettings(), 'Factory defaults restored')
    setConfirmReset(false)
  }

  if (view === 'history') return <section className="settings-manager">
    <header><div><p className="eyebrow">Revision history</p><h2>Saved settings</h2></div>
      <button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button></header>
    {error && <div className="error-banner"><strong>Settings unavailable</strong><span>{error}</span></div>}
    <div className="settings-revisions">
      {history.length === 0 && <p className="settings-empty">No saved revisions.</p>}
      {history.map((entry) => <article key={entry.revision}>
        <div><strong>Revision {entry.revision}</strong><code>{entry.hash}</code></div>
        <button type="button" onClick={() => void restore(entry.revision)} disabled={busy || entry.revision === draft?.revision}>
          Restore to draft
        </button>
      </article>)}
    </div>
    {status && <p className="settings-status">{status}</p>}
  </section>

  return <section className="settings-manager">
    <header><div><p className="eyebrow">Pending configuration</p><h2>Unsaved changes</h2></div>
      <span>Base revision {draft?.revision ?? '—'} · draft generation {draft?.draft_generation ?? '—'}</span></header>
    {error && <div className="error-banner"><strong>Settings unavailable</strong><span>{error}</span></div>}
    <div className={`settings-diff ${diff?.dirty ? 'dirty' : 'clean'}`}>
      <strong>{diff?.dirty ? 'Draft differs from the active settings' : 'No unsaved changes'}</strong>
      <pre>{diff?.unified || 'The persistent draft matches the active revision.'}</pre>
    </div>
    <div className="settings-actions">
      <label>Revision message<input value={message} onChange={(event) => setMessage(event.target.value)} /></label>
      <button type="button" onClick={() => void commit()} disabled={busy || !diff?.dirty || !message.trim()}>Commit</button>
      <button className="secondary" type="button" onClick={() => void discard()} disabled={busy || !diff?.dirty}>Discard</button>
      <button className={confirmReset ? 'danger confirm' : 'danger'} type="button"
        onClick={() => void factoryReset()} disabled={busy}>Factory reset</button>
    </div>
    {status && <p className="settings-status">{status}</p>}
    <p className="settings-note">Factory reset restores packaged defaults and clears settings history and stored secrets. Meter records, waveforms, and logs are preserved.</p>
  </section>
}
