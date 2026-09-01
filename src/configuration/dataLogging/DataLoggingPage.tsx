import { KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react'
import {
  api, ApiError, DataChannelMaterialStatus, DataChannelSettings,
  DataLoggingConfigurationDocument, DataLoggingJobSettings, DataLoggingStatus,
  MeterAttributeCatalog,
} from '../../api'
import { DataChannelEditor } from './DataChannelEditor'
import { DataLoggingJobEditor } from './DataLoggingJobEditor'
import { DataLoggingStatusPanel } from './DataLoggingStatusPanel'
import './dataLogging.css'

const SECTIONS = ['jobs', 'channels', 'status'] as const
type Section = typeof SECTIONS[number]

function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const text = [...bytes].map((value) => value.toString(16).padStart(2, '0'))
  return `${text.slice(0, 4).join('')}-${text.slice(4, 6).join('')}-${text.slice(6, 8).join('')}-${text.slice(8, 10).join('')}-${text.slice(10).join('')}`
}

function newChannel(index: number): DataChannelSettings {
  return { id: uuid(), name: `Data Channel ${index}`, enabled: true,
    protocol: 'https', host: '', port: 0, http_path: '/', remote_directory: '/',
    authentication: 'none', username: '', connect_timeout_seconds: 10,
    transfer_timeout_seconds: 120, use_system_ca: true, use_uploaded_ca: false,
    use_client_certificate: false, insecure_transport_acknowledged: false }
}

function newJob(index: number): DataLoggingJobSettings {
  return { id: uuid(), name: `Logging Job ${index}`, enabled: false, revision: 1,
    source_period: 'basic', generation_interval_seconds: 300,
    row_interval_seconds: 60, selections: [], format: 'json', destination: 'remote',
    channel_ids: [] }
}

export function DataLoggingPage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [section, setSection] = useState<Section>('jobs')
  const [document, setDocument] = useState<DataLoggingConfigurationDocument>()
  const [catalog, setCatalog] = useState<MeterAttributeCatalog>()
  const [status, setStatus] = useState<DataLoggingStatus>()
  const [savedChannelIds, setSavedChannelIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [statusLoading, setStatusLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const errorRef = useRef<HTMLDivElement>(null)

  const failure = useCallback((reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized(); return
    }
    setError(reason instanceof Error ? reason.message : fallback)
  }, [onUnauthorized])

  const loadStatus = useCallback(async (showLoading = false) => {
    if (showLoading) setStatusLoading(true)
    try { setStatus(await api.dataLoggingStatus()) }
    catch (reason) { failure(reason, 'Unable to read Data Sender status') }
    finally { if (showLoading) setStatusLoading(false) }
  }, [failure])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [configuration, attributes] = await Promise.all([
        api.dataLoggingConfiguration(), api.meterAttributes('historian'),
      ])
      setDocument(configuration); setCatalog(attributes)
      setSavedChannelIds(new Set(configuration.settings.channels.map((channel) => channel.id)))
    } catch (reason) { failure(reason, 'Unable to read Data Logging configuration') }
    finally { setLoading(false) }
  }, [failure])

  useEffect(() => { void load(); void loadStatus(true) }, [load, loadStatus])
  useEffect(() => {
    const timer = window.setInterval(() => void loadStatus(false), 3000)
    return () => window.clearInterval(timer)
  }, [loadStatus])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  function editChannel(index: number, next: DataChannelSettings) {
    setDocument((current) => current ? { ...current, settings: { ...current.settings,
      channels: current.settings.channels.map((channel, item) => item === index ? next : channel),
    } } : current)
  }

  function editJob(index: number, next: DataLoggingJobSettings) {
    setDocument((current) => current ? { ...current, settings: { ...current.settings,
      jobs: current.settings.jobs.map((job, item) => item === index ? next : job),
    } } : current)
  }

  function removeChannel(index: number) {
    if (!document) return
    const channel = document.settings.channels[index]
    const affected = document.settings.jobs.filter((job) => job.channel_ids.includes(channel.id))
    const warning = affected.length > 0
      ? ` This also removes it from ${affected.length} logging job${affected.length === 1 ? '' : 's'}.`
      : ''
    if (!window.confirm(`Remove “${channel.name}”?${warning} Queued files may prevent the save until they are delivered or explicitly discarded.`)) return
    setDocument({ ...document, settings: { ...document.settings,
      channels: document.settings.channels.filter((_, item) => item !== index),
      jobs: document.settings.jobs.map((job) => ({ ...job,
        channel_ids: job.channel_ids.filter((id) => id !== channel.id) })),
    } })
  }

  function updateMaterial(next: DataChannelMaterialStatus) {
    setDocument((current) => current ? { ...current,
      materials: [...current.materials.filter((item) => item.channel_id !== next.channel_id), next],
    } : current)
  }

  async function save() {
    if (!document) return
    setBusy(true); setError(''); setMessage('Validating and saving…')
    try {
      const saved = await api.updateDataLoggingConfiguration(document.settings)
      setDocument(saved)
      setSavedChannelIds(new Set(saved.settings.channels.map((channel) => channel.id)))
      setMessage('Saved. New schedules take effect at the next completed UTC boundary; queued delivery continues.')
      window.setTimeout(() => void loadStatus(false), 600)
    } catch (reason) { setMessage(''); failure(reason, 'Unable to save Data Logging configuration') }
    finally { setBusy(false) }
  }

  function tabKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = SECTIONS.indexOf(section)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length
    setSection(SECTIONS[next])
    globalThis.document.getElementById(`data-logging-tab-${SECTIONS[next]}`)?.focus()
  }

  return <div className="data-logging-page">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Data logging</p><h2>Meter Data Sender</h2></div>
      <span>{status?.health ?? (statusLoading ? 'Loading…' : 'Unavailable')}</span>
    </section>
    <p className="data-logging-intro">Choose what the meter records, how files are shaped, and where each completed file goes. Files remain queued through network outages until every selected destination accepts them.</p>
    {error && <div className="error-banner" ref={errorRef} tabIndex={-1} role="alert"><strong>Data Logging needs attention</strong><span>{error}</span></div>}
    {message && <div className="management-success" role="status">{message}</div>}
    <nav className="data-logging-tabs" role="tablist" aria-label="Data Logging sections">
      {SECTIONS.map((value) => <button key={value} id={`data-logging-tab-${value}`}
        type="button" role="tab" aria-selected={section === value}
        tabIndex={section === value ? 0 : -1} className={section === value ? 'active' : ''}
        onKeyDown={tabKey} onClick={() => setSection(value)}>{value === 'jobs' ? 'Logging Jobs' : value === 'channels' ? 'Data Channels' : 'Status'}</button>)}
    </nav>
    {loading && !document && <div className="data-logging-empty">Loading configuration…</div>}
    {document && catalog && section === 'jobs' && <div role="tabpanel" aria-labelledby="data-logging-tab-jobs">
      <div className="data-logging-section-heading"><div><h3>Logging Jobs</h3><p>Each job creates one deterministic JSON or CSV file on a UTC schedule.</p></div>
        <button type="button" className="secondary" disabled={busy}
          onClick={() => setDocument({ ...document, settings: { ...document.settings,
            jobs: [...document.settings.jobs, newJob(document.settings.jobs.length + 1)] } })}>Add logging job</button></div>
      {document.settings.jobs.length === 0 && <div className="data-logging-empty">No jobs yet. Add a logging job to begin; an empty configuration sends no data.</div>}
      <div className="data-logging-jobs">{document.settings.jobs.map((job, index) =>
        <DataLoggingJobEditor key={job.id} job={job} catalog={catalog}
          channels={document.settings.channels}
          demandWindowSeconds={document.demand_window_seconds} disabled={busy}
          onChange={(next) => editJob(index, next)}
          onRemove={() => { if (window.confirm(`Remove “${job.name}”? Existing generated files are preserved.`))
            setDocument({ ...document, settings: { ...document.settings,
              jobs: document.settings.jobs.filter((_, item) => item !== index) } }) }} />)}</div>
      <section className="data-logging-storage"><h3>Storage protection</h3>
        <p>When either guard is reached, new generation pauses. Existing unsent files are never silently removed.</p>
        <div className="data-logging-fields">
          <label>Combined file limit (MiB)<input type="number" min="1" disabled={busy}
            value={Math.round(document.settings.storage.maximum_bytes / 1024 / 1024)}
            onChange={(event) => setDocument({ ...document, settings: { ...document.settings,
              storage: { ...document.settings.storage, maximum_bytes: Number(event.target.value) * 1024 * 1024 } } })} /></label>
          <label>Minimum filesystem free (MiB)<input type="number" min="1" disabled={busy}
            value={Math.round(document.settings.storage.minimum_free_bytes / 1024 / 1024)}
            onChange={(event) => setDocument({ ...document, settings: { ...document.settings,
              storage: { ...document.settings.storage, minimum_free_bytes: Number(event.target.value) * 1024 * 1024 } } })} /></label>
          <label>Completed metadata retention (days)<input type="number" min="1" max="3650" disabled={busy}
            value={document.settings.storage.completed_metadata_retention_days}
            onChange={(event) => setDocument({ ...document, settings: { ...document.settings,
              storage: { ...document.settings.storage, completed_metadata_retention_days: Number(event.target.value) } } })} /></label>
        </div>
      </section>
    </div>}
    {document && section === 'channels' && <div role="tabpanel" aria-labelledby="data-logging-tab-channels">
      <div className="data-logging-section-heading"><div><h3>Data Channels</h3><p>Reusable outbound destinations. Saving a channel never contacts it.</p></div>
        <button type="button" className="secondary" disabled={busy}
          onClick={() => setDocument({ ...document, settings: { ...document.settings,
            channels: [...document.settings.channels, newChannel(document.settings.channels.length + 1)] } })}>Add Data Channel</button></div>
      {document.settings.channels.length === 0 && <div className="data-logging-empty">No remote channels. Local-only jobs remain available.</div>}
      <div className="data-channel-list">{document.settings.channels.map((channel, index) =>
        <DataChannelEditor key={channel.id} channel={channel} disabled={busy}
          saved={savedChannelIds.has(channel.id)}
          material={document.materials.find((item) => item.channel_id === channel.id)}
          runtime={status?.channels.find((item) => item.id === channel.id)}
          onChange={(next) => editChannel(index, next)} onRemove={() => removeChannel(index)}
          onMaterial={updateMaterial} onUnauthorized={onUnauthorized} />)}</div>
    </div>}
    {section === 'status' && <div role="tabpanel" aria-labelledby="data-logging-tab-status">
      <DataLoggingStatusPanel status={status} loading={statusLoading} />
    </div>}
    {document && section !== 'status' && <div className="data-logging-save-bar">
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Review, validate, and save'}</button>
      <span>Protected credentials are stored separately and never appear in this configuration.</span>
    </div>}
  </div>
}
