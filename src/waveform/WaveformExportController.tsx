import {
  createContext, type ReactNode, useCallback, useContext, useEffect,
  useMemo, useRef, useState,
} from 'react'
import {
  api, ApiError, type WaveformExportCapability, type WaveformExportFormat,
  type WaveformExportJob, waveformDownloadPath, waveformEventExportPath,
  waveformExportDownloadPath,
} from '../api'
import './waveformExport.css'

const STORAGE_KEY = 'msap1.waveform-export-jobs.v1'

export interface WaveformExportTarget {
  sessionId: number
  filename: string
  scope: 'capture' | 'event'
  eventId?: string
  capabilities?: WaveformExportCapability[]
}

interface StoredExports {
  owner: string
  jobs: WaveformExportJob[]
  autoDownloaded: string[]
}

interface Controller {
  openExport: (target: WaveformExportTarget) => void
}

const ExportContext = createContext<Controller>({ openExport: () => undefined })

export function useWaveformExport() {
  return useContext(ExportContext)
}

export function clearWaveformExportSession() {
  sessionStorage.removeItem(STORAGE_KEY)
}

function capabilityFallback(): WaveformExportCapability[] {
  return [{
    format: 'mncwf', label: 'MNCWF', profile: 'MNCWF v4/v5',
    extension: '.mncwf', scopes: ['capture', 'event'], asynchronous: false,
  }]
}

function restored(owner: string): StoredExports {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as
      Partial<StoredExports> | null
    if (value?.owner !== owner || !Array.isArray(value.jobs) ||
        !Array.isArray(value.autoDownloaded)) {
      sessionStorage.removeItem(STORAGE_KEY)
      return { owner, jobs: [], autoDownloaded: [] }
    }
    return {
      owner,
      jobs: value.jobs.filter((job): job is WaveformExportJob =>
        typeof job?.job_id === 'string' && typeof job?.state === 'string'),
      autoDownloaded: value.autoDownloaded.filter(
        (id): id is string => typeof id === 'string'),
    }
  } catch {
    sessionStorage.removeItem(STORAGE_KEY)
    return { owner, jobs: [], autoDownloaded: [] }
  }
}

function startBrowserDownload(job: WaveformExportJob) {
  const anchor = document.createElement('a')
  // Restored browser storage is untrusted; downloads remain same-origin.
  anchor.href = waveformExportDownloadPath(job.job_id)
  anchor.download = job.filename
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function immediateDownload(target: WaveformExportTarget) {
  const anchor = document.createElement('a')
  anchor.href = target.scope === 'event' && target.eventId
    ? waveformEventExportPath(target.sessionId, target.eventId)
    : waveformDownloadPath(target.filename)
  anchor.download = ''
  anchor.hidden = true
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function jobProgress(job: WaveformExportJob) {
  if (job.total_frames <= 0) return 0
  return Math.min(100, Math.round(job.processed_frames / job.total_frames * 100))
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

function expiryTime(value: string) {
  // The daemon reports nanoseconds; ECMAScript Date accepts milliseconds.
  const normalized = value.replace(/\.(\d{3})\d*Z$/, '.$1Z')
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isExpired(job: WaveformExportJob, now = Date.now()) {
  const expiry = expiryTime(job.expires_at)
  return expiry !== undefined && expiry <= now
}

export function WaveformExportProvider({ owner, onUnauthorized, children }: {
  owner: string
  onUnauthorized: () => void
  children: ReactNode
}) {
  const initial = useMemo(() => restored(owner), [owner])
  const [jobs, setJobs] = useState<WaveformExportJob[]>(initial.jobs)
  const [autoDownloaded, setAutoDownloaded] = useState<ReadonlySet<string>>(
    new Set(initial.autoDownloaded))
  const [selection, setSelection] = useState<WaveformExportTarget>()
  const [selectedFormat, setSelectedFormat] = useState<WaveformExportFormat>('mncwf')
  const [foregroundJob, setForegroundJob] = useState<string>()
  const [completionQueue, setCompletionQueue] = useState<WaveformExportJob[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [trayOpen, setTrayOpen] = useState(true)
  const [error, setError] = useState('')
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs

  useEffect(() => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      owner, jobs, autoDownloaded: Array.from(autoDownloaded),
    } satisfies StoredExports))
  }, [autoDownloaded, jobs, owner])

  useEffect(() => {
    const pruneExpired = () => {
      const now = Date.now()
      const expired = (job: WaveformExportJob) => isExpired(job, now)
      const expiredIds = new Set(jobsRef.current.filter(expired)
        .map((job) => job.job_id))
      if (expiredIds.size === 0) return
      setJobs((current) => current.filter(
        (job) => !expiredIds.has(job.job_id)))
      setCompletionQueue((current) => current.some(expired)
        ? current.filter((job) => !expired(job)) : current)
      setAutoDownloaded((current) => new Set(Array.from(current).filter(
        (jobId) => !expiredIds.has(jobId))))
    }
    pruneExpired()
    const timer = window.setInterval(pruneExpired, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const updateJob = useCallback((job: WaveformExportJob) => {
    setJobs((current) => {
      const existing = current.findIndex((candidate) => candidate.job_id === job.job_id)
      if (existing < 0) return [...current, job]
      const next = [...current]
      next[existing] = job
      return next
    })
  }, [])

  useEffect(() => {
    const active = jobs.filter((job) => job.state === 'queued' || job.state === 'running')
    if (active.length === 0) return
    let mounted = true
    let pending = false
    const poll = async () => {
      if (!mounted || pending) return
      pending = true
      for (const job of jobsRef.current) {
        if (!mounted || (job.state !== 'queued' && job.state !== 'running')) continue
        try {
          updateJob(await api.waveformExport(job.job_id))
        } catch (reason) {
          if (reason instanceof ApiError && reason.status === 401) {
            clearWaveformExportSession()
            onUnauthorized()
            mounted = false
            break
          }
          if (reason instanceof ApiError && reason.status === 404)
            setJobs((current) => current.filter(
              (candidate) => candidate.job_id !== job.job_id))
        }
      }
      pending = false
    }
    void poll()
    const timer = window.setInterval(poll, 1000)
    return () => { mounted = false; window.clearInterval(timer) }
  }, [jobs.map((job) => `${job.job_id}:${job.state}`).join('|'),
    onUnauthorized, updateJob])

  useEffect(() => {
    const ready = jobs.filter((job) => job.state === 'ready' &&
      !isExpired(job) && !autoDownloaded.has(job.job_id)).sort((first, second) =>
      first.completed_at.localeCompare(second.completed_at))
    if (ready.length === 0) return
    const next = ready[0]
    startBrowserDownload(next)
    setAutoDownloaded((current) => new Set([...current, next.job_id]))
    setCompletionQueue((current) => {
      const existing = new Set(current.map((job) => job.job_id))
      return existing.has(next.job_id) ? current : [...current, next]
    })
  }, [autoDownloaded, jobs])

  const openExport = useCallback((target: WaveformExportTarget) => {
    const capabilities = target.capabilities?.filter(
      (capability) => capability.scopes.includes(target.scope)) ?? capabilityFallback()
    setSelection({ ...target, capabilities })
    setSelectedFormat(capabilities[0]?.format ?? 'mncwf')
    setError('')
  }, [])

  async function submit() {
    if (!selection) return
    if (selectedFormat === 'mncwf') {
      immediateDownload(selection)
      setSelection(undefined)
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const job = await api.submitWaveformExport({
        session_id: selection.sessionId,
        scope: selection.scope,
        ...(selection.eventId ? { event_id: selection.eventId } : {}),
        format: selectedFormat,
      })
      updateJob(job)
      setTrayOpen(true)
      setForegroundJob(job.job_id)
      setSelection(undefined)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        clearWaveformExportSession()
        onUnauthorized()
      } else {
        setError(reason instanceof Error ? reason.message : 'Unable to start export')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function cancel(job: WaveformExportJob) {
    try {
      updateJob(await api.cancelWaveformExport(job.job_id))
      if (foregroundJob === job.job_id) setForegroundJob(undefined)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        clearWaveformExportSession()
        onUnauthorized()
      } else {
        setError(reason instanceof Error ? reason.message : 'Unable to cancel export')
      }
    }
  }

  const foreground = jobs.find((job) => job.job_id === foregroundJob)
  const completion = completionQueue[0]
  const visibleJobs = jobs.filter((job) => job.state !== 'cancelled')

  return <ExportContext.Provider value={{ openExport }}>
    {children}
    {visibleJobs.length > 0 && !trayOpen && <button type="button"
      className="waveform-export-tray-toggle" aria-expanded="false"
      onClick={() => setTrayOpen(true)}>
      Waveform exports ({visibleJobs.length})
    </button>}
    {visibleJobs.length > 0 && trayOpen && <aside className="waveform-export-tray"
      aria-label="Waveform exports">
      <header><strong>Waveform exports</strong>
        <div className="waveform-export-tray-controls">
          <span>{visibleJobs.length}</span>
          <button type="button" className="waveform-export-tray-close"
            aria-label="Close waveform exports" title="Close waveform exports"
            onClick={() => setTrayOpen(false)}>×</button>
        </div>
      </header>
      {error && <p className="waveform-export-tray-error" role="alert">{error}</p>}
      {visibleJobs.map((job) => <article key={job.job_id}>
        <div><strong>{job.filename || `${job.format} export`}</strong>
          <span>{job.state === 'queued' && job.queue_position
            ? `Queued · position ${job.queue_position}`
            : job.state === 'running' ? `Converting · ${jobProgress(job)}%`
            : job.state === 'ready' ? `Ready · ${formatBytes(job.bytes)}`
            : job.error_message || job.state}</span></div>
        {(job.state === 'queued' || job.state === 'running') &&
          <progress max="100" value={jobProgress(job)} />}
        <div className="waveform-export-job-actions">
          {(job.state === 'queued' || job.state === 'running') &&
            <button type="button" onClick={() => void cancel(job)}>Cancel</button>}
          {job.state === 'ready' && <>
            <button type="button"
              onClick={() => startBrowserDownload(job)}>Download again</button>
            <button type="button" onClick={() => void cancel(job)}>Discard</button>
          </>}
          {job.state === 'failed' &&
            <button type="button" onClick={() => setJobs((current) =>
              current.filter((candidate) => candidate.job_id !== job.job_id))}>Dismiss</button>}
        </div>
      </article>)}
    </aside>}

    {selection && <div className="waveform-export-backdrop">
      <section className="waveform-export-dialog" role="dialog" aria-modal="true"
        aria-labelledby="waveform-export-title">
        <p className="eyebrow">Waveform export</p>
        <h2 id="waveform-export-title">Export {selection.scope === 'capture'
          ? `session ${selection.sessionId}` : 'event slice'}</h2>
        <fieldset><legend>File format</legend>
          {(selection.capabilities ?? capabilityFallback()).map((capability) =>
            <label key={capability.format}>
              <input type="radio" name="waveform-export-format"
                value={capability.format} checked={selectedFormat === capability.format}
                onChange={() => setSelectedFormat(capability.format)} />
              <span><strong>{capability.label}</strong><small>{capability.profile}</small></span>
            </label>)}
        </fieldset>
        {selectedFormat === 'comtrade-zip' && <p className="waveform-export-note">
          Legacy ZIP contains separate .cfg and .dat files.</p>}
        {selectedFormat !== 'mncwf' && <p className="waveform-export-note">
          Conversion continues if you navigate away. The download starts automatically when ready.</p>}
        {error && <p className="waveform-export-error" role="alert">{error}</p>}
        <div className="waveform-export-actions">
          <button type="button" className="secondary" disabled={submitting}
            onClick={() => setSelection(undefined)}>Cancel</button>
          <button type="button" disabled={submitting} onClick={() => void submit()}>
            {submitting ? 'Starting…' : selectedFormat === 'mncwf' ? 'Download' : 'Start export'}
          </button>
        </div>
      </section>
    </div>}

    {foreground && (foreground.state === 'queued' || foreground.state === 'running') &&
      <div className="waveform-export-backdrop">
        <section className="waveform-export-dialog" role="dialog" aria-modal="true"
          aria-labelledby="waveform-export-progress-title">
          <p className="eyebrow">{foreground.profile}</p>
          <h2 id="waveform-export-progress-title">Preparing waveform export</h2>
          <progress max="100" value={jobProgress(foreground)} />
          <p>{foreground.state === 'queued'
            ? `Queued${foreground.queue_position ? ` · position ${foreground.queue_position}` : ''}`
            : `${foreground.processed_frames.toLocaleString()} of ${
              foreground.total_frames.toLocaleString()} frames`}</p>
          <div className="waveform-export-actions">
            <button type="button" className="secondary"
              onClick={() => void cancel(foreground)}>Cancel</button>
            <button type="button" onClick={() => setForegroundJob(undefined)}>
              Run in background</button>
          </div>
        </section>
      </div>}

    {completion && <div className="waveform-export-backdrop">
      <section className="waveform-export-dialog ready" role="dialog" aria-modal="true"
        aria-labelledby="waveform-export-complete-title">
        <p className="eyebrow">Export complete</p>
        <h2 id="waveform-export-complete-title">{completion.filename}</h2>
        <p>{formatBytes(completion.bytes)} · SHA-256</p>
        <code>{completion.sha256}</code>
        <div className="waveform-export-actions">
          <button type="button" className="secondary"
            onClick={() => setCompletionQueue((current) => current.slice(1))}>Done</button>
          <button type="button" onClick={() => startBrowserDownload(completion)}>
            Download again</button>
        </div>
      </section>
    </div>}
  </ExportContext.Provider>
}
