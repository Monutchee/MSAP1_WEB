import { FormEvent, useCallback, useEffect, useState } from 'react'
import {
  api, ApiError, DatabaseSettings, DatabaseStatus,
  DatasetStorageSettings, HistorianDataset,
} from '../api'
import './database.css'

const DATASETS: Array<{ key: keyof DatabaseSettings; label: string; note: string }> = [
  { key: 'spool', label: 'Raw record spool', note: 'Lossless handoff to durable consumers' },
  { key: 'basic', label: 'Basic 10/12-cycle', note: 'High-rate historical values' },
  { key: 'cycles_150_180', label: '150/180-cycle', note: '15 basic-block aggregate' },
  { key: 'minutes_10', label: '10-minute', note: 'Future PL measurement product' },
  { key: 'hours_2', label: '2-hour', note: 'Future PL measurement product' },
]

function formatBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function clonePolicies(value: DatabaseSettings): DatabaseSettings {
  return structuredClone(value)
}

function formatTimestamp(nanoseconds?: number) {
  if (nanoseconds === undefined || nanoseconds === 0) return '—'
  return new Date(nanoseconds / 1_000_000).toLocaleString()
}

export function DeveloperDatabasePage({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [status, setStatus] = useState<DatabaseStatus>()
  const [policies, setPolicies] = useState<DatabaseSettings>()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  /*
   * The status poll below refreshes every three seconds. It must never adopt
   * server policies once the operator has started editing, or their typing is
   * silently reverted mid-edit and "Apply and save" appears to do nothing:
   * `busy` is only set while a request is in flight, not while editing.
   */
  const [dirty, setDirty] = useState(false)
  /*
   * Raw retention text while a field is being edited. A number input is
   * momentarily empty during backspacing, and Number('') is 0 -- which means
   * "forever" in this model and would unmount the input. Keeping the raw
   * string lets the field hold a transient empty value without changing the
   * policy, so 0 keeps meaning forever and only an explicit choice sets it.
   */
  const [retentionDraft, setRetentionDraft] =
    useState<Partial<Record<keyof DatabaseSettings, string>>>({})
  const migrationBusy = status?.historian.migration_in_progress ?? false
  const controlsDisabled = busy || migrationBusy

  const load = useCallback(async () => {
    try {
      const next = await api.developerDatabase()
      setStatus(next)
      /* Live counters always refresh; the editable form does not once the
       * operator has unsaved changes. */
      if (!busy && !dirty && !next.historian.migration_in_progress)
        setPolicies(clonePolicies(next.policies))
      setError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) return onUnauthorized()
      setError(reason instanceof Error ? reason.message : 'Unable to read database status')
    }
  }, [busy, dirty, onUnauthorized])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { if (!busy) void load() }, 3000)
    return () => window.clearInterval(timer)
  }, [busy, load])

  function update(key: keyof DatabaseSettings, patch: Partial<DatasetStorageSettings>) {
    setDirty(true)
    setPolicies((current) => current ? {
      ...current,
      [key]: { ...current[key], ...patch },
    } : current)
  }

  /* Commit a retention edit. An empty or unparseable field leaves the stored
   * policy untouched and is reconciled on blur, so the input never collapses
   * into the "forever" state while the operator is still typing. */
  function editRetention(key: keyof DatabaseSettings, raw: string) {
    setRetentionDraft((current) => ({ ...current, [key]: raw }))
    const parsed = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(parsed) || parsed <= 0) return
    update(key, { maximum_age_seconds: Math.floor(parsed) })
  }

  /* Discard an abandoned partial edit and show the value actually held. */
  function commitRetention(key: keyof DatabaseSettings) {
    setRetentionDraft((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!policies) return
    if (policies.spool.backend === 'memory' &&
        !policies.spool.volatile_spool_acknowledged) {
      setError('Confirm the volatile-spool warning before applying memory mode.')
      return
    }
    setBusy(true)
    setMessage('Applying policy and backfilling retained records…')
    setError('')
    try {
      const next = await api.updateDeveloperDatabase(policies)
      setStatus(next)
      /* Adopt what the server actually stored, and reopen the form to polling:
       * the edit is committed, so there is nothing left to protect. */
      setRetentionDraft({})
      setDirty(false)
      setPolicies(clonePolicies(next.policies))
      setMessage('Applied and saved.')
    } catch (reason) {
      setMessage('')
      setError(reason instanceof Error ? reason.message : 'Database policy update failed')
    } finally {
      setBusy(false)
    }
  }

  async function maintain(action: 'clear_datasets' | 'recreate_historian',
    datasets: HistorianDataset[], prompt: string) {
    if (!window.confirm(prompt)) return
    setBusy(true)
    setError('')
    setMessage(action === 'recreate_historian'
      ? 'Deleting and recreating the historian database…'
      : 'Clearing selected historical data…')
    try {
      const next = await api.maintainDeveloperDatabase(action === 'clear_datasets'
        ? { action, datasets, confirmed: true }
        : { action, datasets: [], confirmed: true })
      setStatus(next)
      /* Maintenance replaces the form with server state, so any pending edit is
       * gone: clear the dirty flag too, or polling stays blocked for the rest
       * of the session. */
      setRetentionDraft({})
      setDirty(false)
      setPolicies(clonePolicies(next.policies))
      setMessage(action === 'recreate_historian'
        ? 'Historian database recreated.'
        : 'Historical data cleared.')
    } catch (reason) {
      setMessage('')
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Database maintenance failed')
    } finally { setBusy(false) }
  }

  return <section className="database-page">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Data logging</p><h2>Historical storage</h2></div>
      <span>Raw spool and historian projections</span>
    </section>
    <div className="database-health-grid">
      <article><span>Meter stream</span><strong>{status?.stream.healthy ? 'Healthy' : 'Unavailable'}</strong>
        <small>{status ? `${status.stream.record_count.toLocaleString()} records · ${formatBytes(status.stream.storage_bytes)}` : 'Loading…'}</small></article>
      <article><span>Historian</span><strong>{status?.historian.healthy ? 'Healthy' : 'Unavailable'}</strong>
        <small>{status ? `${status.historian.block_count.toLocaleString()} blocks · ${formatBytes(status.historian.storage_bytes)}` : 'Loading…'}</small></article>
      <article><span>Historian lag</span><strong>{status?.historian.lag_records.toLocaleString() ?? '—'}</strong>
        <small>stream records awaiting ACK</small></article>
      <article><span>Durability</span><strong>{status?.stream.durability ? 'Persistent' : 'Volatile'}</strong>
        <small>spool cursor {status?.stream.oldest_cursor ?? 0}…{status?.stream.newest_cursor ?? 0}</small></article>
    </div>
    {status && <div className="database-cursors">
      <strong>Durable consumer cursors</strong>
      {status.stream.consumers.length > 0
        ? status.stream.consumers.map((consumer) => <span key={consumer.name}>
          {consumer.name}: {consumer.acknowledged_cursor.toLocaleString()}
        </span>)
        : <span>No durable consumers registered</span>}
      <small>Unacknowledged spool records are never pruned.</small>
    </div>}
    {status?.historian.migration_in_progress &&
      <div className="database-progress">Backend migration and spool backfill are in progress.</div>}
    {status?.historian.backfill_incomplete &&
      <div className="database-progress database-warning">The requested projection begins at spool cursor {status.historian.oldest_available_stream_cursor.toLocaleString()}; older source records are no longer available for backfill.</div>}
    {error && <div className="error-banner"><strong>Database unavailable</strong><span>{error}</span></div>}
    {policies && <form className="database-policy-table" onSubmit={save}>
      <header><span>Dataset</span><span>Storage</span><span>Retention</span><span>Maximum size</span></header>
      {DATASETS.map(({ key, label, note }) => {
        const policy = policies[key]
        const live = status?.historian.datasets.find((item) => item.dataset === key)
        return <fieldset key={key} disabled={controlsDisabled}>
          <legend><strong>{label}</strong><small>{note}</small></legend>
          <label>Storage<select value={policy.backend}
            onChange={(event) => update(key, { backend: event.target.value as 'memory' | 'persistent' })}>
            <option value="memory">Memory</option><option value="persistent">Persistent</option>
          </select></label>
          <label>Retention<select value={policy.maximum_age_seconds === 0 ? 'forever' : 'custom'}
            onChange={(event) => update(key, {
              maximum_age_seconds: event.target.value === 'forever' ? 0 : 86400,
            })}>
            <option value="forever">Forever</option><option value="custom">Custom</option>
          </select>{policy.maximum_age_seconds > 0 && <input type="number" min="60" step="1"
            value={retentionDraft[key] ?? String(policy.maximum_age_seconds)}
            onChange={(event) => editRetention(key, event.target.value)}
            onBlur={() => commitRetention(key)}
            aria-label={`${label} retention seconds`} />}<small>{policy.maximum_age_seconds > 0 ? 'seconds' : 'no age limit'}</small></label>
          <label>Maximum bytes<input type="number" min="0" step="1048576"
            value={policy.maximum_bytes}
            onChange={(event) => update(key, { maximum_bytes: Number(event.target.value) })} />
            <small>{policy.maximum_bytes ? formatBytes(policy.maximum_bytes) : 'no size limit'}</small></label>
          <div className="dataset-live"><span>{live?.block_count.toLocaleString() ?? '—'} blocks</span>
            <span>{live ? formatBytes(live.storage_bytes) : key === 'spool' ? formatBytes(status?.stream.storage_bytes ?? 0) : '—'}</span>
            {key !== 'spool' && <span>retained {formatTimestamp(live?.oldest_nanoseconds)} … {formatTimestamp(live?.newest_nanoseconds)}</span>}
          </div>
          {key === 'spool' && policy.backend === 'memory' && <label className="volatile-warning">
            <input type="checkbox" checked={policy.volatile_spool_acknowledged}
              onChange={(event) => update(key, { volatile_spool_acknowledged: event.target.checked })} />
            I understand that an in-memory spool is non-durable and intended only for controlled testing.
          </label>}
        </fieldset>
      })}
      <div className="database-actions"><button type="submit" disabled={controlsDisabled}>Apply and save</button>
        <span>{message}</span></div>
    </form>}
    <section className="database-danger-zone">
      <div><p className="eyebrow">Maintenance</p><h2>Clear data logs</h2>
        <p>These operations remove historian projections. The durable raw-record spool is not deleted.</p></div>
      <div className="database-maintenance-actions">
        <button className="secondary" type="button" disabled={controlsDisabled}
          onClick={() => void maintain('clear_datasets', ['basic'],
            'Clear all Basic 10/12-cycle historical data? This cannot be undone.')}>Clear Basic data</button>
        <button className="secondary" type="button" disabled={controlsDisabled}
          onClick={() => void maintain('clear_datasets', ['cycles_150_180'],
            'Clear all 150/180-cycle historical data? This cannot be undone.')}>Clear 150/180-cycle data</button>
        <button className="danger" type="button" disabled={controlsDisabled}
          onClick={() => void maintain('recreate_historian', [],
            'Delete and recreate the complete historian database? All historical projections will be permanently removed; the raw spool is preserved.')}>Delete and recreate historian</button>
      </div>
    </section>
  </section>
}
