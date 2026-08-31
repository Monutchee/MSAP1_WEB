import { FormEvent, useCallback, useEffect, useState } from 'react'
import {
  api, ApiError, dataLoggingArtifactDownloadPath, GeneratedArtifactSummary,
  GeneratedDeliveryDetail,
} from '../api'

function localDateTimeValue(value: Date) {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function GeneratedFiles({ onUnauthorized, canDelete }: {
  onUnauthorized: () => void
  canDelete: boolean
}) {
  const [files, setFiles] = useState<GeneratedArtifactSummary[]>([])
  const [jobs, setJobs] = useState<{ id: string; name: string }[]>([])
  const [job, setJob] = useState('')
  const [state, setState] = useState('')
  const [start, setStart] = useState(() => localDateTimeValue(new Date(Date.now() - 24 * 3600_000)))
  const [end, setEnd] = useState(() => localDateTimeValue(new Date()))
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [preview, setPreview] = useState<{
    id: string; text: string; deliveries: GeneratedDeliveryDetail[]
  }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const fail = useCallback((reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 401) { onUnauthorized(); return }
    setError(reason instanceof Error ? reason.message : fallback)
  }, [onUnauthorized])

  const load = useCallback(async (nextOffset = offset) => {
    setBusy(true); setError('')
    try {
      const [page, configuration] = await Promise.all([
        api.dataLoggingArtifacts({ offset: nextOffset, limit: 100, job_id: job,
          state, start_nanoseconds: new Date(start).getTime() * 1_000_000,
          end_nanoseconds: new Date(end).getTime() * 1_000_000 }),
        canDelete ? api.dataLoggingConfiguration().catch(() => undefined)
          : Promise.resolve(undefined),
      ])
      setFiles(page.artifacts); setOffset(nextOffset); setSelected([])
      setJobs(configuration
        ? configuration.settings.jobs.map((item) => ({ id: item.id, name: item.name }))
        : [...new Set(page.artifacts.map((item) => item.job_id))]
          .map((id) => ({ id, name: id })))
    } catch (reason) { fail(reason, 'Unable to list generated files') }
    finally { setBusy(false) }
  }, [canDelete, end, fail, job, offset, start, state])

  useEffect(() => { void load(0) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function submit(event: FormEvent) { event.preventDefault(); void load(0) }

  async function showPreview(file: GeneratedArtifactSummary) {
    setBusy(true); setError('')
    try {
      const [text, detail] = await Promise.all([
        api.dataLoggingPreview(file.id), api.dataLoggingArtifact(file.id),
      ])
      setPreview({ id: file.id, text, deliveries: detail.deliveries })
    }
    catch (reason) { fail(reason, 'Unable to preview generated file') }
    finally { setBusy(false) }
  }

  async function retry() {
    setBusy(true); setError(''); setMessage('')
    try {
      await api.retryDataLoggingArtifacts(selected)
      setMessage('Selected failed deliveries were made eligible for retry.')
      await load(offset)
    } catch (reason) { fail(reason, 'Unable to retry selected files') }
    finally { setBusy(false) }
  }

  async function remove() {
    if (!window.confirm(`Delete ${selected.length} selected generated file${selected.length === 1 ? '' : 's'}?`)) return
    setBusy(true); setError(''); setMessage('')
    try {
      let result
      try {
        result = await api.deleteDataLoggingArtifacts({ ids: selected,
          confirmed: true, discard_unsent: false })
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.status !== 409) throw reason
        if (!window.confirm('At least one selected file has not reached every destination. Discard those unsent deliveries and permanently delete the files?')) return
        result = await api.deleteDataLoggingArtifacts({ ids: selected,
          confirmed: true, discard_unsent: true })
      }
      setMessage(`${result.deleted} generated file${result.deleted === 1 ? '' : 's'} deleted.`)
      await load(Math.max(0, offset - (files.length === selected.length && offset > 0 ? 100 : 0)))
    } catch (reason) { fail(reason, 'Unable to delete selected files') }
    finally { setBusy(false) }
  }

  return <div className="generated-files">
    {error && <div className="error-banner"><strong>Generated files unavailable</strong><span>{error}</span></div>}
    {message && <div className="management-success" role="status">{message}</div>}
    <form className="generated-file-filters" onSubmit={submit}>
      <label>Logging job<select value={job} onChange={(event) => setJob(event.target.value)}>
        <option value="">All jobs</option>{jobs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label>Delivery state<select value={state} onChange={(event) => setState(event.target.value)}>
        <option value="">All states</option><option value="pending">Pending</option>
        <option value="partially_delivered">Partially delivered</option><option value="blocked">Blocked</option>
        <option value="succeeded">Delivered</option><option value="local_only">Local-only</option>
        <option value="missing_payload">Missing payload</option></select></label>
      <label>From<input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} /></label>
      <label>To<input type="datetime-local" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
      <button type="submit" disabled={busy}>Apply filters</button>
    </form>
    {canDelete && <div className="generated-file-actions">
      <span>{selected.length} selected</span>
      <button type="button" className="secondary" disabled={busy || selected.length === 0}
        onClick={() => void retry()}>Retry delivery</button>
      <button type="button" className="danger" disabled={busy || selected.length === 0}
        onClick={() => void remove()}>Delete selected</button>
    </div>}
    <div className="generated-file-table-wrap"><table className="generated-file-table">
      <thead><tr>{canDelete && <th><span className="sr-only">Select</span></th>}
        <th>Generated file</th><th>Source window</th><th>State</th><th>Delivery</th><th>Size</th><th>Actions</th></tr></thead>
      <tbody>{files.map((file) => <tr key={file.id}>
        {canDelete && <td><input type="checkbox" aria-label={`Select ${file.filename}`}
          checked={selected.includes(file.id)} onChange={(event) => setSelected((current) =>
            event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id))} /></td>}
        <td><strong>{file.filename}</strong><small>{jobs.find((item) => item.id === file.job_id)?.name ?? file.job_id} · revision {file.job_revision}</small></td>
        <td>{new Date(file.source_start_nanoseconds / 1_000_000).toLocaleString()}<small>to {new Date(file.source_end_nanoseconds / 1_000_000).toLocaleString()}</small></td>
        <td><span className={`artifact-state ${file.state}`}>{file.state.replaceAll('_', ' ')}</span>
          {file.recovery_error && <small className="bad">{file.recovery_error}</small>}</td>
        <td>{file.local_only ? 'No network' : `${file.succeeded_count} of ${file.delivery_count}`}<small>{file.blocked_count ? `${file.blocked_count} blocked` : 'at-least-once'}</small></td>
        <td>{formatBytes(file.size_bytes)}</td>
        <td><button type="button" className="secondary" disabled={busy || !file.payload_present}
          onClick={() => void showPreview(file)}>Preview</button>
          {file.payload_present && <a className="secondary button-link" href={dataLoggingArtifactDownloadPath(file.id)} download>Download</a>}</td>
      </tr>)}</tbody>
    </table></div>
    {files.length === 0 && <div className="history-empty">No generated files match these filters.</div>}
    <div className="generated-file-pagination"><button type="button" className="secondary"
      disabled={busy || offset === 0} onClick={() => void load(Math.max(0, offset - 100))}>Previous</button>
      <span>Showing {files.length === 0 ? 0 : offset + 1}–{offset + files.length}</span>
      <button type="button" className="secondary" disabled={busy || files.length < 100}
        onClick={() => void load(offset + 100)}>Next</button></div>
    {preview && <section className="generated-file-preview" aria-label="Generated file preview">
      <header><strong>Preview</strong><span>{files.find((file) => file.id === preview.id)?.filename}</span>
        <button type="button" className="secondary" onClick={() => setPreview(undefined)}>Close</button></header>
      <p>Quality, coverage, and partial-data markers are retained exactly as generated.</p>
      {preview.deliveries.length > 0 && <div className="generated-file-deliveries">
        {preview.deliveries.map((delivery) => <div key={delivery.channel_id}>
          <strong>{delivery.channel_id}</strong><span>{delivery.state.replaceAll('_', ' ')} · {delivery.attempt_count} attempt{delivery.attempt_count === 1 ? '' : 's'}</span>
          {delivery.last_error && <small className="bad">{delivery.last_error}</small>}
        </div>)}
      </div>}
      <pre>{preview.text}</pre>
    </section>}
  </div>
}
