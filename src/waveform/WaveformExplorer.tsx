import { useCallback, useEffect, useState } from 'react'
import {
  api, ApiError, waveformDownloadPath, WaveformSession, WaveformStatus,
} from '../api'
import { WaveformTriggerPanel } from './WaveformTriggerPanel'
import { WaveformViewer } from './WaveformViewer'
import './waveform.css'

/**
 * One coarse health verdict for the page header. The detailed counters live
 * in Developer -> Waveform; here a capture either looks healthy or it does
 * not. All inputs are cumulative since daemon start, so the flag latches
 * until the acquisition service restarts - deliberate, because the loss it
 * reports usually happened while nobody was watching.
 */
function waveformIssue(status: WaveformStatus | undefined) {
  if (!status) return undefined
  if (!status.running) return 'Waveform DMA is not running'
  if (status.sequence_gaps > 0 || status.invalid_blocks > 0 ||
    status.transport_overrun_blocks > 0 || status.pl_dropped_frames > 0)
    return 'Frames were lost since start-up'
  if (status.materialization_failures > 0)
    return 'A capture file failed to write'
  return ''
}

function count(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function sessionTime(session: WaveformSession) {
  if (!session.trigger_realtime_nanoseconds) return 'Legacy capture'
  return new Date(session.trigger_realtime_nanoseconds / 1_000_000).toLocaleString()
}

function duration(session: WaveformSession) {
  if (!session.sample_rate_hz || session.last_sequence < session.first_sequence)
    return '—'
  return `${((session.last_sequence - session.first_sequence + 1) /
    session.sample_rate_hz).toFixed(3)} s`
}

/*
 * The mncwf layout is deterministic, so the size is computable from the
 * session metadata alone: 256-byte header, 7 channel descriptors of 32
 * bytes, 24 bytes per event, then 28 bytes (7 persisted channels x 4) per
 * stored frame — where sequences span acquisition frames and the file
 * stores one frame per decimation group.
 */
function fileSize(session: WaveformSession) {
  if (session.state !== 'complete' || !session.filename ||
    session.last_sequence < session.first_sequence)
    return undefined
  const storedFrames = (session.last_sequence - session.first_sequence) /
    Math.max(1, session.decimation) + 1
  const bytes = 256 + 7 * 32 + session.event_count * 24 + storedFrames * 28
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} kB`
  return `${bytes} B`
}

export function WaveformExplorer({ onUnauthorized, canDelete }: {
  onUnauthorized: () => void
  canDelete: boolean
}) {
  const [status, setStatus] = useState<WaveformStatus>()
  const [loadingFile, setLoadingFile] = useState('')
  const [deletingSession, setDeletingSession] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [viewer, setViewer] = useState<{ filename: string; buffer: ArrayBuffer }>()
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setStatus(await api.waveforms())
      setError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to read waveform history')
    }
  }, [onUnauthorized])

  useEffect(() => {
    let active = true
    const refresh = async () => {
      if (active) await load()
    }
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [load])

  async function open(session: WaveformSession) {
    if (!session.filename) return
    setLoadingFile(session.filename)
    setError('')
    try {
      const buffer = await api.waveformFile(session.filename)
      setViewer({ filename: session.filename, buffer })
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to load waveform file')
    } finally {
      setLoadingFile('')
    }
  }

  async function remove(session: WaveformSession) {
    if (session.state === 'capturing' ||
      !window.confirm(`Delete waveform session ${session.id}? This cannot be undone.`))
      return
    setDeletingSession(session.id)
    setError('')
    try {
      const next = await api.deleteWaveform(session.id)
      setStatus(next)
      if (viewer?.filename === session.filename) setViewer(undefined)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to delete waveform')
    } finally {
      setDeletingSession(0)
    }
  }

  const sessions = status?.sessions ?? []
  // A capture still being written cannot be deleted, so it never selects.
  const deletable = sessions.filter((session) => session.state !== 'capturing')
  const allSelected = deletable.length > 0 &&
    deletable.every((session) => selected.has(session.id))

  function toggleSelected(id: number) {
    const next = new Set(selected)
    if (!next.delete(id)) next.add(id)
    setSelected(next)
  }

  function toggleSelectAll() {
    setSelected(allSelected
      ? new Set()
      : new Set(deletable.map((session) => session.id)))
  }

  async function removeSelected() {
    const targets = deletable.filter((session) => selected.has(session.id))
    if (targets.length === 0 ||
      !window.confirm(`Delete ${targets.length} waveform session(s)? This cannot be undone.`))
      return
    setBulkDeleting(true)
    setError('')
    const failures: string[] = []
    try {
      for (const session of targets) {
        try {
          const next = await api.deleteWaveform(session.id)
          setStatus(next)
          if (viewer?.filename === session.filename) setViewer(undefined)
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 401) {
            onUnauthorized()
            return
          }
          failures.push(`session ${session.id}: ${
            reason instanceof Error ? reason.message : 'delete failed'}`)
        }
      }
      if (failures.length > 0)
        setError(`Unable to delete ${failures.length} of ${targets.length} — ${failures[0]}`)
    } finally {
      setSelected(new Set())
      setBulkDeleting(false)
    }
  }

  const issue = waveformIssue(status)

  return <section className="waveform-explorer-page">
    <div className="developer-heading">
      <div><p className="eyebrow">Waveforms</p><h1>Capture history</h1>
        <p>Browse persistent pre/post-trigger captures and inspect raw or converted values.</p></div>
      <button className="waveform-refresh" type="button" onClick={() => void load()}>
        Refresh history
      </button>
    </div>
    <div className="waveform-capture-strip">
      <span className={`status-pill ${status?.active_session ? 'ok' : ''}`}>
        <i />{status?.active_session ? 'Capture active' : 'Idle'}
      </span>
      {issue !== undefined &&
        <span className={`status-pill ${issue ? 'bad' : 'ok'}`}
          title={issue ? 'Details in Developer → Waveform' : undefined}>
          <i />{issue || 'Healthy'}
        </span>}
    </div>
    {error && <div className="error-banner"><strong>Waveform error</strong><span>{error}</span></div>}
    {canDelete && <WaveformTriggerPanel status={status} onStatus={setStatus}
      onUnauthorized={onUnauthorized} />}
    <section className="waveform-library">
      <header>
        <div><p className="eyebrow">Persistent storage</p><h2>Saved captures</h2></div>
        <div className="waveform-library-tools">
          <span>{status?.completed_sessions ?? 0} complete · {status?.incomplete_sessions ?? 0} incomplete</span>
          {canDelete && deletable.length > 0 && <>
            <label className="waveform-select-all">
              <input type="checkbox" checked={allSelected}
                onChange={toggleSelectAll} />Select all
            </label>
            <button className="waveform-delete" type="button"
              disabled={selected.size === 0 || bulkDeleting}
              onClick={() => void removeSelected()}>
              {bulkDeleting ? 'Deleting…' : `Delete selected (${selected.size})`}
            </button>
          </>}
        </div>
      </header>
      <div className="waveform-library-list">
        {sessions.map((session) =>
          <article key={session.id}
            className={selected.has(session.id) ? 'selected' : undefined}>
            <div className="waveform-session-identity">
              {canDelete && <input type="checkbox" className="waveform-session-select"
                aria-label={`Select session ${session.id}`}
                checked={selected.has(session.id)}
                disabled={session.state === 'capturing'}
                onChange={() => toggleSelected(session.id)} />}
              <strong>Session {session.id}</strong>
              <span className={`session-state ${session.state}`}>{session.state}</span>
              <time>{sessionTime(session)}</time>
            </div>
            <dl>
              <div><dt>Duration</dt><dd>{duration(session)}</dd></div>
              <div><dt>Sample rate</dt><dd>{count(session.sample_rate_hz)} frame/s
                {session.decimation > 1 ? ` ÷ ${session.decimation}` : ''}</dd></div>
              <div><dt>Frames</dt><dd>{count(session.last_sequence - session.first_sequence + 1)}</dd></div>
              <div><dt>Events</dt><dd>{session.event_count}</dd></div>
              {fileSize(session) &&
                <div><dt>File size</dt><dd>{fileSize(session)}</dd></div>}
            </dl>
            <code>{session.filename || 'Capture is not materialized'}</code>
            <div className="waveform-session-actions">
              <button type="button" disabled={session.state !== 'complete' ||
                !session.filename || loadingFile === session.filename}
                onClick={() => void open(session)}>
                {loadingFile === session.filename ? 'Loading…' : 'View waveform'}
              </button>
              {session.state === 'complete' && session.filename
                ? <a href={waveformDownloadPath(session.filename)} download>Download</a>
                : <span>File unavailable</span>}
              {canDelete && <button className="waveform-delete" type="button"
                disabled={session.state === 'capturing' ||
                  deletingSession === session.id}
                onClick={() => void remove(session)}>
                {deletingSession === session.id ? 'Deleting…' : 'Delete'}
              </button>}
            </div>
          </article>)}
        {sessions.length === 0 &&
          <div className="waveform-library-empty">
            <strong>No persistent waveform captures</strong>
            <span>{canDelete
              ? 'Trigger a capture with the form above.'
              : 'An administrator can trigger a capture from this page.'}</span>
          </div>}
      </div>
    </section>
    {viewer && <WaveformViewer key={viewer.filename}
      filename={viewer.filename} buffer={viewer.buffer}
      onClose={() => setViewer(undefined)} />}
  </section>
}
