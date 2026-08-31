import { DataLoggingStatus } from '../../api'

function formatBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatTime(nanoseconds?: number) {
  return nanoseconds && nanoseconds > 0
    ? new Date(nanoseconds / 1_000_000).toLocaleString() : 'Not yet'
}

export function DataLoggingStatusPanel({ status, loading }: {
  status?: DataLoggingStatus
  loading: boolean
}) {
  if (!status && loading) return <div className="data-logging-empty">Loading Data Sender status…</div>
  if (!status) return <div className="data-logging-empty">Data Sender status is unavailable.</div>
  return <div className="data-logging-status">
    {!status.generation_allowed && <div className="data-logging-critical" role="alert">
      <strong>New file generation is paused</strong>
      <span>{status.storage_blocking_reason}</span>
    </div>}
    <div className="data-logging-summary">
      <article><span>Service</span><strong>{status.health}</strong><small>{status.message}</small></article>
      <article><span>Waiting to send</span><strong>{status.pending_delivery_count}</strong><small>{status.outbox_count} files · {formatBytes(status.outbox_bytes)}</small></article>
      <article><span>Blocked</span><strong>{status.blocked_delivery_count}</strong><small>requires attention</small></article>
      <article><span>Local archive</span><strong>{status.archive_count}</strong><small>{formatBytes(status.archive_bytes)}</small></article>
      <article><span>Delivered records</span><strong>{status.completed_metadata_count}</strong><small>delivery history retained</small></article>
      <article><span>Missing payload</span><strong>{status.missing_payload_count}</strong><small>{status.missing_payload_count === 0 ? 'storage healthy' : 'requires administrator attention'}</small></article>
      <article><span>Storage limit</span><strong>{formatBytes(status.maximum_bytes)}</strong><small>{formatBytes(status.available_bytes)} filesystem free</small></article>
      <article><span>Oldest waiting file</span><strong>{formatTime(status.oldest_pending_created_at_nanoseconds)}</strong><small>retained until every channel succeeds</small></article>
    </div>
    <section className="data-logging-runtime-list"><h3>Logging jobs</h3>
      {status.jobs.length === 0 && <p>No jobs are configured.</p>}
      {status.jobs.map((job) => <article key={job.id}>
        <header><strong>{job.id}</strong><span>{job.enabled ? 'Enabled' : 'Disabled'} · revision {job.revision}</span></header>
        <dl><div><dt>Next completed window</dt><dd>{formatTime(job.next_end_nanoseconds)}</dd></div>
          <div><dt>Last generated window</dt><dd>{formatTime(job.last_end_nanoseconds)}</dd></div>
          <div><dt>Last generation</dt><dd>{formatTime(job.last_generated_at_nanoseconds)}</dd></div></dl>
        {job.last_error && <p className="bad">{job.last_error}</p>}
      </article>)}
    </section>
    <section className="data-logging-runtime-list"><h3>Data Channels</h3>
      {status.channels.length === 0 && <p>No remote channels are configured.</p>}
      {status.channels.map((channel) => <article key={channel.id}>
        <header><strong>{channel.name}</strong><span>{channel.protocol.toUpperCase()} · {channel.enabled ? 'Enabled' : 'Disabled'}</span></header>
        <dl><div><dt>Readiness</dt><dd>{channel.ready ? 'Ready' : 'Needs attention'}</dd></div>
          <div><dt>Last test</dt><dd>{channel.last_test_state} · {formatTime(channel.last_test_at_nanoseconds)}</dd></div></dl>
        {(channel.readiness_error || channel.last_test_message) &&
          <p className={channel.ready ? '' : 'bad'}>{channel.readiness_error || channel.last_test_message}</p>}
      </article>)}
    </section>
  </div>
}
