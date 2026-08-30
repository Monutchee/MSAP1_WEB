import { useCallback, useEffect, useState } from 'react'
import {
  api, ApiError, DatabaseStatus, HistorianDataset, WaveformStatus,
} from '../api'
import { ConfirmDialog, ConfirmDialogState } from '../components/ConfirmDialog'
import './management.css'

const ALL_HISTORY_DATASETS: HistorianDataset[] = [
  'basic', 'cycles_150_180', 'minutes_10', 'hours_2', 'demand',
  'harmonic_cycles_150_180', 'harmonic_minutes_10', 'harmonic_hours_2',
]

type ManagementAction =
  | { kind: 'history'; datasets: HistorianDataset[] }
  | { kind: 'events' }
  | { kind: 'waveforms' }

interface PendingAction {
  action: ManagementAction
  dialog: ConfirmDialogState
}

export function ManagementPage({ onUnauthorized }: {
  onUnauthorized: () => void
}) {
  const [database, setDatabase] = useState<DatabaseStatus>()
  const [waveforms, setWaveforms] = useState<WaveformStatus>()
  const [pending, setPending] = useState<PendingAction>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dialogError, setDialogError] = useState('')
  const [message, setMessage] = useState('')

  const handleFailure = useCallback((reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return 'unauthorized'
    }
    return reason instanceof Error ? reason.message : fallback
  }, [onUnauthorized])

  const load = useCallback(async () => {
    const [nextDatabase, nextWaveforms] = await Promise.allSettled([
      api.developerDatabase(), api.waveforms(),
    ])
    const failures: string[] = []
    if (nextDatabase.status === 'fulfilled') setDatabase(nextDatabase.value)
    else failures.push(handleFailure(nextDatabase.reason, 'Unable to read historian status'))
    if (nextWaveforms.status === 'fulfilled') setWaveforms(nextWaveforms.value)
    else failures.push(handleFailure(nextWaveforms.reason, 'Unable to read waveform status'))
    setError(failures.filter((failure) => failure !== 'unauthorized').join(' · '))
  }, [handleFailure])

  useEffect(() => {
    void load()
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [load])

  function request(action: ManagementAction, dialog: ConfirmDialogState) {
    setDialogError('')
    setPending({ action, dialog })
  }

  async function confirm() {
    if (!pending) return
    setBusy(true)
    setDialogError('')
    setMessage('')
    try {
      if (pending.action.kind === 'history') {
        await api.maintainDeveloperDatabase({
          action: 'clear_datasets',
          datasets: pending.action.datasets,
          confirmed: true,
        })
        setMessage('Selected meter data logs were cleared. The raw-record spool was preserved.')
      } else if (pending.action.kind === 'events') {
        const result = await api.clearPowerQualityEvents()
        setMessage(`${result.deleted.toLocaleString()} power-quality event${result.deleted === 1 ? '' : 's'} cleared. MNCWF files were preserved.`)
      } else {
        const previous = waveforms?.sessions.length ?? 0
        await api.clearWaveforms()
        setMessage(`${previous.toLocaleString()} waveform session${previous === 1 ? '' : 's'} cleared.`)
      }
      setPending(undefined)
      await load()
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setDialogError(reason instanceof Error ? reason.message : 'Management operation failed')
    } finally {
      setBusy(false)
    }
  }

  const waveformCount = waveforms?.sessions.length ?? 0
  const captureActive = waveforms?.active_session ?? false
  return <section className="management-page">
    <div className="developer-heading">
      <div><p className="eyebrow">Administration</p><h1>Management</h1>
        <p>Remove retained meter data, power-quality events, and waveform files.</p></div>
      <button type="button" onClick={() => void load()}>Refresh status</button>
    </div>
    {error && <div className="error-banner"><strong>Management status unavailable</strong>
      <span>{error}</span></div>}
    {message && <div className="management-success" role="status">{message}</div>}
    <div className="management-summary">
      <article><span>Meter history</span><strong>{database?.historian.block_count.toLocaleString() ?? '—'}</strong><small>retained blocks</small></article>
      <article><span>PQ catalogue</span><strong>{database?.historian.power_quality_event_count.toLocaleString() ?? '—'}</strong><small>durable events</small></article>
      <article><span>Waveforms</span><strong>{waveformCount.toLocaleString()}</strong><small>{captureActive ? 'capture active' : 'stored sessions'}</small></article>
    </div>
    <section className="management-card">
      <header><div><p className="eyebrow">Meter history</p><h2>Clear data logs</h2></div>
        <span>The lossless raw-record spool is not deleted.</span></header>
      <p>Remove historian projections without changing storage policy or stopping acquisition.</p>
      <div className="management-actions">
        <button type="button" className="secondary" disabled={busy}
          onClick={() => request({ kind: 'history', datasets: ['basic'] }, {
            title: 'Clear Basic 10/12-cycle data?',
            description: 'All retained Basic measurement blocks will be permanently removed. The raw spool and other historian periods remain available.',
            confirmLabel: 'Clear Basic data',
          })}>Clear Basic data</button>
        <button type="button" className="secondary" disabled={busy}
          onClick={() => request({ kind: 'history', datasets: ['cycles_150_180'] }, {
            title: 'Clear 150/180-cycle data?',
            description: 'All retained 150/180-cycle aggregate records will be permanently removed. Other periods remain available.',
            confirmLabel: 'Clear 150/180-cycle data',
          })}>Clear 150/180-cycle data</button>
        <button type="button" className="danger" disabled={busy}
          onClick={() => request({ kind: 'history', datasets: ALL_HISTORY_DATASETS }, {
            title: 'Clear all meter data logs?',
            description: 'Every scalar and harmonic historian projection will be permanently removed. The raw spool, PQ event catalogue, waveform files, and storage policies are preserved.',
            confirmLabel: 'Clear all data logs',
          })}>Clear all data logs</button>
      </div>
    </section>
    <section className="management-card">
      <header><div><p className="eyebrow">Power quality</p><h2>Clear PQ event catalogue</h2></div>
        <span>{database?.historian.power_quality_event_count.toLocaleString() ?? '—'} events</span></header>
      <p>Remove every canonical event and its evidence link. Shared MNCWF capture files remain until cleared separately.</p>
      <div className="management-actions">
        <button type="button" className="danger" disabled={busy ||
          (database?.historian.power_quality_event_count ?? 0) === 0}
          onClick={() => request({ kind: 'events' }, {
            title: 'Clear all PQ events?',
            description: 'The complete durable event catalogue and all event-to-waveform links will be permanently removed. Waveform files are preserved.',
            confirmLabel: 'Clear all PQ events',
          })}>Clear all PQ events</button>
      </div>
    </section>
    <section className="management-card">
      <header><div><p className="eyebrow">Waveform storage</p><h2>Clear waveform data</h2></div>
        <span>{captureActive ? 'Capture active' : `${waveformCount} sessions`}</span></header>
      <p>Remove manual and PQ capture sessions and their MNCWF files. PQ catalogue rows are not deleted.</p>
      {captureActive && <div className="management-warning">Wait for the active capture to finish before clearing waveform data.</div>}
      <div className="management-actions">
        <button type="button" className="danger"
          disabled={busy || captureActive || waveformCount === 0}
          onClick={() => request({ kind: 'waveforms' }, {
            title: 'Clear all waveform data?',
            description: 'Every inactive manual and PQ waveform session and its MNCWF master file will be permanently removed. Event catalogue records remain.',
            confirmLabel: 'Clear all waveforms',
          })}>Clear all waveform data</button>
      </div>
    </section>
    <ConfirmDialog state={pending?.dialog} busy={busy} error={dialogError}
      onCancel={() => { if (!busy) setPending(undefined) }}
      onConfirm={() => void confirm()} />
  </section>
}
