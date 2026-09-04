import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api, ApiError, waveformDownloadPath, WaveformOrigin,
  WaveformOriginFilter, WaveformSession, WaveformStatus,
} from '../api'
import { WaveformTriggerPanel } from './WaveformTriggerPanel'
import { WaveformViewer } from './WaveformViewer'
import { ParsedWaveform, WaveformPyramid } from './waveformFile'
import { processWaveform } from './waveformWorkerClient'
import './waveform.css'

const waveformPageSize = 16

/**
 * One coarse health verdict for the page header. The detailed counters live
 * in Developer -> Waveform; here a capture either looks healthy or it does
 * not. All inputs are cumulative since daemon start, so the flag latches
 * until the acquisition service restarts.
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

function gibibytes(value: number) {
  return `${(value / (1024 ** 3)).toFixed(2)} GiB`
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

export function waveformOriginLabel(origin: WaveformOrigin) {
  switch (origin) {
    case 'manual': return 'Manual trigger'
    case 'power_quality': return 'PQ event trigger'
    case 'mixed': return 'Manual + PQ event'
    case 'legacy': return 'Legacy / unknown trigger'
  }
}

function hasLinkedPqEvidence(session: WaveformSession) {
  return session.origin === 'power_quality' || session.origin === 'mixed'
}

function mergeSessions(current: WaveformSession[], incoming: WaveformSession[]) {
  const sessions = new Map(current.map((session) => [session.id, session]))
  incoming.forEach((session) => sessions.set(session.id, session))
  return Array.from(sessions.values()).sort((first, second) => second.id - first.id)
}

export function WaveformExplorer({
  onUnauthorized, canDelete, acquisitionAvailable = true,
}: {
  onUnauthorized: () => void
  canDelete: boolean
  acquisitionAvailable?: boolean
}) {
  const [status, setStatus] = useState<WaveformStatus>()
  const [sessions, setSessions] = useState<WaveformSession[]>([])
  const [origin, setOrigin] = useState<WaveformOriginFilter>('all')
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loadingFile, setLoadingFile] = useState('')
  const [deletingSession, setDeletingSession] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [viewer, setViewer] = useState<{
    filename: string
    waveform: ParsedWaveform
    pyramid: WaveformPyramid
  }>()
  const [error, setError] = useState('')
  const originRef = useRef(origin)
  const archiveStateRef = useRef<string>()
  const loadedOlderRef = useRef(false)
  originRef.current = origin

  const handleFailure = useCallback((reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return
    }
    setError(reason instanceof Error ? reason.message : fallback)
  }, [onUnauthorized])

  const loadNewest = useCallback(async (replace = false) => {
    if (!acquisitionAvailable) return
    const requestedOrigin = origin
    try {
      const next = await api.waveforms({ origin: requestedOrigin, limit: waveformPageSize })
      if (originRef.current !== requestedOrigin) return
      const archiveState = next.archive_discovery?.state
      const indexingCompleted = archiveStateRef.current === 'scanning' &&
        archiveState === 'complete'
      archiveStateRef.current = archiveState
      setStatus(next)
      if (replace || indexingCompleted) {
        loadedOlderRef.current = false
        setSessions(next.sessions)
        setNextBefore(next.page?.next_before_session_id ?? null)
        setSelected(new Set())
      } else {
        setSessions((current) => mergeSessions(current, next.sessions))
        if (!loadedOlderRef.current)
          setNextBefore(next.page?.next_before_session_id ?? null)
      }
      setError('')
    } catch (reason) {
      if (originRef.current === requestedOrigin)
        handleFailure(reason, 'Unable to read waveform history')
    }
  }, [acquisitionAvailable, handleFailure, origin])

  useEffect(() => {
    setSelected(new Set())
    setSessions([])
    setNextBefore(null)
    setLoadingOlder(false)
    loadedOlderRef.current = false
    archiveStateRef.current = undefined
    if (!acquisitionAvailable) {
      setStatus(undefined)
      setError('')
      return
    }
    let active = true
    let pending = false
    let firstPage = true
    const refresh = async () => {
      if (!active || pending) return
      pending = true
      await loadNewest(firstPage)
      firstPage = false
      pending = false
    }
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [acquisitionAvailable, loadNewest])

  const loadOlder = useCallback(async () => {
    if (nextBefore === null || status?.archive_discovery?.state === 'scanning') return
    const requestedOrigin = origin
    setLoadingOlder(true)
    setError('')
    try {
      const next = await api.waveforms({
        origin: requestedOrigin,
        before_session_id: nextBefore,
        limit: waveformPageSize,
      })
      if (originRef.current !== requestedOrigin) return
      loadedOlderRef.current = true
      setStatus(next)
      setSessions((current) => mergeSessions(current, next.sessions))
      setNextBefore(next.page?.next_before_session_id ?? null)
    } catch (reason) {
      if (originRef.current === requestedOrigin)
        handleFailure(reason, 'Unable to load older waveform captures')
    } finally {
      if (originRef.current === requestedOrigin) setLoadingOlder(false)
    }
  }, [handleFailure, nextBefore, origin, status?.archive_discovery?.state])

  const open = useCallback(async (session: WaveformSession) => {
    if (!session.filename) return
    setLoadingFile(session.filename)
    setError('')
    try {
      const buffer = await api.waveformFile(session.filename)
      const processed = await processWaveform(buffer)
      setViewer({ filename: session.filename, ...processed })
    } catch (reason) {
      handleFailure(reason, 'Unable to load waveform file')
    } finally {
      setLoadingFile('')
    }
  }, [handleFailure])

  async function remove(session: WaveformSession) {
    if (session.state === 'capturing') return
    const evidenceWarning = hasLinkedPqEvidence(session)
      ? ' Linked PQ event evidence will become unavailable.' : ''
    if (!window.confirm(`Delete waveform session ${session.id}?${evidenceWarning} This cannot be undone.`))
      return
    setDeletingSession(session.id)
    setError('')
    try {
      await api.deleteWaveform(session.id)
      if (viewer?.filename === session.filename) setViewer(undefined)
      await loadNewest(true)
    } catch (reason) {
      handleFailure(reason, 'Unable to delete waveform')
    } finally {
      setDeletingSession(0)
    }
  }

  const deletable = sessions.filter((session) => session.state !== 'capturing')
  const allSelected = deletable.length > 0 &&
    deletable.every((session) => selected.has(session.id))

  function toggleSelected(id: number) {
    const next = new Set(selected)
    if (!next.delete(id)) next.add(id)
    setSelected(next)
  }

  function toggleSelectShown() {
    setSelected(allSelected
      ? new Set()
      : new Set(deletable.map((session) => session.id)))
  }

  async function removeSelected() {
    const targets = deletable.filter((session) => selected.has(session.id))
    const evidenceWarning = targets.some(hasLinkedPqEvidence)
      ? ' Linked PQ event evidence for the selected captures will become unavailable.' : ''
    if (targets.length === 0 ||
      !window.confirm(`Delete ${targets.length} waveform session(s)?${evidenceWarning} This cannot be undone.`))
      return
    setBulkDeleting(true)
    setError('')
    const failures: string[] = []
    try {
      for (const session of targets) {
        try {
          await api.deleteWaveform(session.id)
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
      await loadNewest(true)
      if (failures.length > 0)
        setError(`Unable to delete ${failures.length} of ${targets.length} — ${failures[0]}`)
    } finally {
      setSelected(new Set())
      setBulkDeleting(false)
    }
  }

  const issue = waveformIssue(status)
  const archive = status?.archive_discovery
  const archiveIndexing = archive?.state === 'scanning'
  const totals = status?.page
  const totalSessions = totals?.total_sessions ?? sessions.length
  const completedSessions = totals?.completed_sessions ??
    sessions.filter((session) => session.state === 'complete').length
  const incompleteSessions = totals?.incomplete_sessions ??
    sessions.filter((session) => session.state === 'incomplete').length

  return <section className="waveform-explorer-page">
    <div className="developer-heading">
      <div><p className="eyebrow">Waveforms</p><h1>Capture history</h1>
        <p>Browse persistent manual and PQ-event captures and inspect raw or converted values.</p></div>
      <button className="waveform-refresh" type="button" onClick={() => void loadNewest(true)}>
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
      {archive && <span className={`status-pill ${archive.state === 'complete' ? 'ok' : 'neutral'}`}>
        <i />{archive.state === 'scanning'
          ? `Indexing archive ${count(archive.scanned_files)}/${count(archive.total_files)}`
          : archive.state === 'complete' ? 'Archive indexed' : `Archive ${archive.state}`}
      </span>}
      {status && <span className={`status-pill ${status.retention_failures ? 'bad' : 'neutral'}`}>
        <i />Archive {gibibytes(status.archive_stored_bytes)} / {gibibytes(status.archive_limit_bytes)}
        {status.expired_sessions ? ` · ${count(status.expired_sessions)} expired` : ''}
      </span>}
    </div>
    {error && <div className="error-banner"><strong>Waveform error</strong><span>{error}</span></div>}
    {canDelete && <WaveformTriggerPanel status={status} onStatus={(next) => {
      setStatus(next)
      void loadNewest(true)
    }} onUnauthorized={onUnauthorized} />}
    <section className="waveform-library">
      <header>
        <div><p className="eyebrow">Persistent storage</p><h2>Saved captures</h2></div>
        <div className="waveform-library-tools">
          <label className="waveform-origin-filter">
            <span>Trigger type</span>
            <select aria-label="Filter captures by trigger type" value={origin}
              onChange={(event) => {
                const next = event.target.value as WaveformOriginFilter
                originRef.current = next
                setOrigin(next)
                setSelected(new Set())
              }}>
              <option value="all">All</option>
              <option value="manual">Manual trigger only</option>
              <option value="power_quality">PQ event trigger only</option>
            </select>
          </label>
          <span>{count(completedSessions)} complete · {count(incompleteSessions)} incomplete ·
            {' '}{count(sessions.length)} of {count(totalSessions)} shown</span>
          {canDelete && deletable.length > 0 && <>
            <label className="waveform-select-all">
              <input type="checkbox" checked={allSelected}
                onChange={toggleSelectShown} />Select shown
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
              <span className={`waveform-origin ${session.origin}`}
                aria-label={`Trigger origin: ${waveformOriginLabel(session.origin)}`}>
                {waveformOriginLabel(session.origin)}
              </span>
              <time>{sessionTime(session)}</time>
            </div>
            <dl>
              <div><dt>Duration</dt><dd>{duration(session)}</dd></div>
              <div><dt>Sample rate</dt><dd>{count(session.sample_rate_hz)} frame/s
                {session.decimation > 1 ? ` ÷ ${session.decimation}` : ''}</dd></div>
              <div><dt>Samples</dt><dd>
                {count((session.last_sequence - session.first_sequence) /
                  Math.max(1, session.decimation) + 1)}
                {session.decimation > 1 &&
                  ` of ${count(session.last_sequence - session.first_sequence + 1)}`}
              </dd></div>
              <div><dt>Events</dt><dd>{session.event_count}</dd></div>
              <div><dt>Format</dt><dd>MNCWF v{session.format_version} · {
                session.compression === 'none' ? 'uncompressed' :
                session.compression.replaceAll('_', ' ')}</dd></div>
              {session.stored_bytes > 0 && <div><dt>Stored</dt><dd>{
                gibibytes(session.stored_bytes)}{
                  session.logical_sample_bytes > 0
                    ? ` (${Math.round(session.stored_bytes /
                        session.logical_sample_bytes * 100)}% of samples)` : ''}</dd></div>}
              <div><dt>Segment</dt><dd>{session.continuation_of_session_id
                ? `Continuation of ${session.continuation_of_session_id}` : 'Master'}</dd></div>
              <div><dt>Master</dt><dd>Session {session.master_session_id || session.id}</dd></div>
              {session.capture_uuid && <div className="waveform-capture-uuid">
                <dt>Capture UUID</dt><dd>{session.capture_uuid}</dd></div>}
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
            <strong>{archiveIndexing ? 'Indexing saved captures' : 'No matching waveform captures'}</strong>
            <span>{archiveIndexing
              ? 'Validated files appear here as archive indexing progresses.'
              : origin === 'all'
              ? canDelete ? 'Trigger a capture with the form above.'
                : 'No saved manual or PQ-event captures are available.'
              : 'Choose All or another trigger filter to browse the archive.'}</span>
          </div>}
      </div>
      {nextBefore !== null && <div className="waveform-load-older">
        <button type="button" disabled={loadingOlder || archiveIndexing}
          onClick={() => void loadOlder()}>
          {archiveIndexing ? 'Indexing archive…'
            : loadingOlder ? 'Loading…' : 'Load older captures'}
        </button>
      </div>}
    </section>
    {viewer && <WaveformViewer key={viewer.filename}
      filename={viewer.filename} waveform={viewer.waveform} pyramid={viewer.pyramid}
      onClose={() => setViewer(undefined)} />}
  </section>
}
