import { useCallback, useEffect, useState } from 'react'
import {
  api, ApiError, waveformDownloadPath, WaveformSession, WaveformStatus,
} from '../api'
import { WaveformViewer } from './WaveformViewer'
import './waveform.css'

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

export function WaveformExplorer({ onUnauthorized, canDelete }: {
  onUnauthorized: () => void
  canDelete: boolean
}) {
  const [status, setStatus] = useState<WaveformStatus>()
  const [loadingFile, setLoadingFile] = useState('')
  const [deletingSession, setDeletingSession] = useState(0)
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

  return <section className="waveform-explorer-page">
    <div className="developer-heading">
      <div><p className="eyebrow">Waveforms</p><h1>Capture history</h1>
        <p>Browse persistent pre/post-trigger captures and inspect raw or converted values.</p></div>
      <button className="waveform-refresh" type="button" onClick={() => void load()}>
        Refresh history
      </button>
    </div>
    {error && <div className="error-banner"><strong>Waveform error</strong><span>{error}</span></div>}
    <section className="waveform-library">
      <header>
        <div><p className="eyebrow">Persistent storage</p><h2>Saved captures</h2></div>
        <span>{status?.completed_sessions ?? 0} complete · {status?.incomplete_sessions ?? 0} incomplete</span>
      </header>
      <div className="waveform-library-list">
        {(status?.sessions ?? []).map((session) =>
          <article key={session.id}>
            <div className="waveform-session-identity">
              <strong>Session {session.id}</strong>
              <span className={`session-state ${session.state}`}>{session.state}</span>
              <time>{sessionTime(session)}</time>
            </div>
            <dl>
              <div><dt>Duration</dt><dd>{duration(session)}</dd></div>
              <div><dt>Sample rate</dt><dd>{count(session.sample_rate_hz)} frame/s</dd></div>
              <div><dt>Frames</dt><dd>{count(session.last_sequence - session.first_sequence + 1)}</dd></div>
              <div><dt>Events</dt><dd>{session.event_count}</dd></div>
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
        {(status?.sessions.length ?? 0) === 0 &&
          <div className="waveform-library-empty">
            <strong>No persistent waveform captures</strong>
            <span>Trigger a capture from Configuration → Waveform.</span>
          </div>}
      </div>
    </section>
    {viewer && <WaveformViewer key={viewer.filename}
      filename={viewer.filename} buffer={viewer.buffer}
      onClose={() => setViewer(undefined)} />}
  </section>
}
