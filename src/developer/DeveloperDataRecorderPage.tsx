import { useState } from 'react'
import { api, ApiError, DatabaseStatus } from '../api'
import './database.css'

/*
 * Cursor tracer for the durable record path.
 *
 * This page deliberately does NOT poll. Every other developer view refreshes on
 * a timer, but reading this status opens the spool and the historian databases,
 * and those are the two writers whose throughput decides whether recent history
 * exists at all. A background timer here would add contention to the exact path
 * being diagnosed, so the operator asks for each sample explicitly.
 *
 * Milestone note: the MeterDataStreamer (spool -> historian projections) is
 * traced below. MeterDataSnapshot is intended to appear alongside it as a second
 * recorder section, which is why the layout is organised per recorder rather
 * than as one flat table.
 */

function formatBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatCursor(cursor: number) {
  return cursor === 0 ? '—' : cursor.toLocaleString()
}

/* Nanosecond epoch to local time. Zero and undefined both mean "no rows". */
function formatTimestamp(nanoseconds?: number) {
  if (nanoseconds === undefined || nanoseconds === 0) return '—'
  return new Date(nanoseconds / 1_000_000).toLocaleString()
}

/*
 * A consumer is behind by however many records sit between its acknowledged
 * cursor and the newest published one. Reported per consumer because a single
 * lagging reader is what holds spool pruning back for everyone.
 */
function consumerLag(status: DatabaseStatus, acknowledged: number) {
  const newest = status.stream.newest_cursor
  return newest > acknowledged ? newest - acknowledged : 0
}

export function DeveloperDataRecorderPage({ onUnauthorized }: {
  onUnauthorized: () => void
}) {
  const [status, setStatus] = useState<DatabaseStatus>()
  const [sampledAt, setSampledAt] = useState<Date>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function refresh() {
    setBusy(true)
    setError('')
    try {
      const next = await api.developerDatabase()
      setStatus(next)
      setSampledAt(new Date())
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401)
        return onUnauthorized()
      setError(reason instanceof Error
        ? reason.message : 'Unable to read recorder status')
    } finally {
      setBusy(false)
    }
  }

  const spoolDatasets = status
    ? status.historian.datasets.filter((dataset) => dataset.dataset !== 'spool')
    : []

  return <section className="database-page">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Data recorder</p><h2>Cursor tracer</h2></div>
      <span>Sampled only on request; probing opens the databases the recorders write to</span>
    </section>
    <div className="database-actions">
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        {busy ? 'Sampling…' : 'Refresh'}</button>
      <span>{sampledAt
        ? `Sampled ${sampledAt.toLocaleTimeString()}`
        : 'Not sampled yet'}</span>
    </div>

    {error && <div className="error-banner"><strong>Recorder unavailable</strong>
      <span>{error}</span></div>}

    {!status && !error && <div className="database-progress">
      Press Refresh to take a sample.</div>}

    {status && <>
      <h3>MeterDataStreamer</h3>

      {/* The spool itself: the single durable handoff every consumer reads. */}
      <div className="database-health-grid">
        <article><span>Spool records</span>
          <strong>{status.stream.record_count.toLocaleString()}</strong>
          <small>{formatBytes(status.stream.storage_bytes)}
            {status.stream.durability ? ' · persistent' : ' · in memory'}</small></article>
        <article><span>Cursor range</span>
          <strong>{formatCursor(status.stream.oldest_cursor)} … {formatCursor(status.stream.newest_cursor)}</strong>
          <small>oldest retained … newest published</small></article>
        <article><span>Consumers</span>
          <strong>{status.stream.consumers.length}</strong>
          <small>services reading the spool</small></article>
        <article><span>Projections</span>
          <strong>{spoolDatasets.length}</strong>
          <small>databases fed from it</small></article>
      </div>

      {/*
        * Per consumer: the cursor it has acknowledged and how far that is behind
        * the newest published record. Pruning cannot pass the minimum of these,
        * so the worst lag here is what keeps the spool large.
        */}
      <h4>Consumer cursors</h4>
      {status.stream.consumers.length === 0
        ? <div className="database-progress">No consumer has registered.</div>
        : <table className="recorder-table">
          <thead><tr><th>Consumer</th><th>Acknowledged cursor</th>
            <th>Records behind</th></tr></thead>
          <tbody>{status.stream.consumers.map((consumer) => {
            const lag = consumerLag(status, consumer.acknowledged_cursor)
            return <tr key={consumer.name}>
              <td>{consumer.name}</td>
              <td>{formatCursor(consumer.acknowledged_cursor)}</td>
              <td className={lag > 0 ? 'recorder-lagging' : ''}>
                {lag.toLocaleString()}</td>
            </tr>
          })}</tbody>
        </table>}

      {/*
        * The historian is the consumer that turns spooled records into queryable
        * history, so its own lag and per-projection extents are what the History
        * page actually serves.
        */}
      <h4>Historian projection</h4>
      <div className="database-health-grid">
        <article><span>Acknowledged cursor</span>
          <strong>{formatCursor(status.historian.acknowledged_cursor)}</strong>
          <small>newest projected record</small></article>
        <article><span>Records behind</span>
          <strong className={status.historian.lag_records > 0 ? 'recorder-lagging' : ''}>
            {status.historian.lag_records.toLocaleString()}</strong>
          <small>still to project from the spool</small></article>
        <article><span>Blocks stored</span>
          <strong>{status.historian.block_count.toLocaleString()}</strong>
          <small>{formatBytes(status.historian.storage_bytes)}</small></article>
      </div>
      {status.historian.migration_in_progress &&
        <div className="database-progress">A policy migration is in progress.</div>}
      {status.historian.backfill_incomplete &&
        <div className="database-progress database-warning">Rebuild starts at spool
          cursor {status.historian.oldest_available_stream_cursor.toLocaleString()};
          older source records are no longer retained.</div>}

      <table className="recorder-table">
        <thead><tr><th>Projection</th><th>Storage</th><th>Blocks</th>
          <th>Size</th><th>Oldest</th><th>Latest</th></tr></thead>
        <tbody>{spoolDatasets.map((dataset) => <tr key={dataset.dataset}>
          <td>{dataset.dataset}</td>
          <td>{dataset.backend}</td>
          <td>{dataset.block_count.toLocaleString()}</td>
          <td>{formatBytes(dataset.storage_bytes)}</td>
          <td>{formatTimestamp(dataset.oldest_nanoseconds)}</td>
          <td>{formatTimestamp(dataset.newest_nanoseconds)}</td>
        </tr>)}</tbody>
      </table>

      <h3>MeterDataSnapshot</h3>
      <div className="database-progress">Not traced yet — planned for the next
        milestone.</div>
    </>}
  </section>
}
