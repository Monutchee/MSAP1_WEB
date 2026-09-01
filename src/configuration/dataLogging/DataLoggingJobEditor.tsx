import { AttributePicker } from '../../components/AttributePicker'
import {
  DataChannelSettings, DataLoggingJobSettings, MeterAttributeCalculation,
  MeterAttributeCatalog,
} from '../../api'

const GENERATION_INTERVALS = [60, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400]
const ROW_INTERVALS = [1, 3, 10, 30, 60, 300, 600, 900, 1800, 3600, 7200]
const PERIOD_MINIMUM: Record<string, number> = {
  basic: 1, cycles_150_180: 3, minutes_10: 600, hours_2: 7200, demand: 600,
}

function compatibleIntervals(seed: number[], minimum: number, current: number,
  maximum: number) {
  return [...new Set([...seed, minimum, minimum * 2, minimum * 3,
    minimum * 6, minimum * 12, minimum * 24, current])]
    .filter((value) => value >= minimum && value <= maximum && value % minimum === 0)
    .sort((left, right) => left - right)
}

function duration(value: number) {
  if (value < 60) return `${value} second${value === 1 ? '' : 's'}`
  if (value < 3600) return `${value / 60} minute${value === 60 ? '' : 's'}`
  if (value < 86400) return `${value / 3600} hour${value === 3600 ? '' : 's'}`
  return `${value / 86400} day${value === 86400 ? '' : 's'}`
}

export function DataLoggingJobEditor({ job, catalog, channels, demandWindowSeconds,
  disabled, onChange,
  onRemove }: {
  job: DataLoggingJobSettings
  catalog: MeterAttributeCatalog
  channels: DataChannelSettings[]
  demandWindowSeconds: number
  disabled: boolean
  onChange: (next: DataLoggingJobSettings) => void
  onRemove: () => void
}) {
  const selected = [...new Set(job.selections.map((selection) => selection.attribute))]
  const period = catalog.periods.find((entry) => entry.id === job.source_period)
  const available = new Set(period?.attributes ?? [])
  const minimum = job.source_period === 'demand'
    ? demandWindowSeconds : (PERIOD_MINIMUM[job.source_period] ?? 1)
  const generationIntervals = compatibleIntervals(GENERATION_INTERVALS, minimum,
    job.generation_interval_seconds, 31 * 24 * 60 * 60)
  const rowIntervals = compatibleIntervals(ROW_INTERVALS, minimum,
    job.row_interval_seconds, job.generation_interval_seconds).filter((value) =>
    job.generation_interval_seconds % value === 0)

  function attributes(next: string[]) {
	const nextSet = new Set(next)
	const selections = job.selections.filter((selection) =>
	  nextSet.has(selection.attribute))
	for (const attribute of next)
	  if (!selections.some((selection) => selection.attribute === attribute)) {
		const descriptor = catalog.attributes.find((candidate) =>
		  candidate.id === attribute)
		selections.push({ attribute,
		  calculation: descriptor?.calculations[0] ?? 'last' })
	  }
	onChange({ ...job, selections })
  }

  function calculation(attribute: string, value: MeterAttributeCalculation,
    checked: boolean) {
	const exists = job.selections.some((selection) =>
	  selection.attribute === attribute && selection.calculation === value)
	if (checked && !exists)
	  onChange({ ...job, selections: [...job.selections,
		{ attribute, calculation: value }] })
	else if (!checked && exists)
	  onChange({ ...job, selections: job.selections.filter((selection) =>
		selection.attribute !== attribute || selection.calculation !== value) })
  }

  function changePeriod(next: string) {
    const nextAvailable = new Set(catalog.periods.find((entry) => entry.id === next)?.attributes ?? [])
    const invalid = selected.filter((attribute) => !nextAvailable.has(attribute))
    if (invalid.length > 0 && !window.confirm(
      `${invalid.length} selected attribute${invalid.length === 1 ? '' : 's'} ` +
      `cannot be logged for this source period. Remove ${invalid.length === 1 ? 'it' : 'them'} and continue?`)) return
    const nextMinimum = next === 'demand' ? demandWindowSeconds : (PERIOD_MINIMUM[next] ?? 60)
	const candidates = compatibleIntervals(GENERATION_INTERVALS, nextMinimum,
	  job.generation_interval_seconds, 31 * 24 * 60 * 60)
	const generation = candidates.find((value) =>
	  value >= job.generation_interval_seconds) ?? candidates.at(-1) ?? nextMinimum
	const row = compatibleIntervals(ROW_INTERVALS, nextMinimum,
	  nextMinimum, generation).find((value) => generation % value === 0) ?? nextMinimum
    onChange({ ...job, source_period: next, generation_interval_seconds: generation,
      row_interval_seconds: row,
      selections: job.selections.filter((selection) => nextAvailable.has(selection.attribute)) })
  }

  return <article className="data-logging-job-card">
    <header><div><strong>{job.name || 'Unnamed job'}</strong>
      <span>Revision {job.revision} · {job.enabled ? 'Enabled' : 'Disabled'}</span></div>
      <button type="button" className="secondary" disabled={disabled} onClick={onRemove}>Remove</button></header>
    <ol className="job-editor-steps">
      <li><section><h4>1. Name and schedule</h4>
        <div className="data-logging-fields">
          <label>Job name<input value={job.name} disabled={disabled}
            onChange={(event) => onChange({ ...job, name: event.target.value })} /></label>
          <label className="toggle"><input type="checkbox" checked={job.enabled} disabled={disabled}
            onChange={(event) => onChange({ ...job, enabled: event.target.checked })} />Enable scheduled generation</label>
          <label>Source period<select value={job.source_period} disabled={disabled}
            onChange={(event) => changePeriod(event.target.value)}>
            {catalog.periods.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}
          </select></label>
          <label>Generate one file every<select value={job.generation_interval_seconds}
            disabled={disabled} onChange={(event) => {
              const generation = Number(event.target.value)
			  const compatible = compatibleIntervals(ROW_INTERVALS, minimum,
				job.row_interval_seconds, generation).filter((value) =>
				generation % value === 0)
			  onChange({ ...job, generation_interval_seconds: generation,
				row_interval_seconds: compatible.includes(job.row_interval_seconds)
				  ? job.row_interval_seconds : compatible[0] ?? generation })
			}}>{generationIntervals.map((value) =>
			  <option value={value} key={value}>{duration(value)}</option>)}</select></label>
          <label>One output row every<select value={job.row_interval_seconds} disabled={disabled}
            onChange={(event) => onChange({ ...job, row_interval_seconds: Number(event.target.value) })}>
            {rowIntervals.map((value) => <option value={value} key={value}>{duration(value)}</option>)}</select></label>
        </div>
        <p>Windows align to completed UTC boundaries. A 5-minute file with 1-minute rows produces exactly five rows.</p>
      </section></li>
      <li><section><h4>2. Select data and calculations</h4>
        <AttributePicker catalog={catalog} period={job.source_period} selected={selected}
          disabled={disabled} onChange={attributes} />
		{selected.length > 0 && <div className="job-calculations">
		  {selected.map((attribute) => {
			const descriptor = catalog.attributes.find((candidate) =>
			  candidate.id === attribute)
			return <fieldset key={attribute} disabled={disabled || !available.has(attribute)}>
			  <legend>{descriptor?.label ?? attribute}</legend>
			  {descriptor?.calculations.map((value) => <label key={value}>
				<input type="checkbox" checked={job.selections.some((selection) =>
				  selection.attribute === attribute && selection.calculation === value)}
				  onChange={(event) => calculation(attribute, value,
					event.target.checked)} />
				{value.replaceAll('_', ' ')}</label>)}
			</fieldset>
		  })}
		</div>}
      </section></li>
      <li><section><h4>3. Format and destination</h4>
        <div className="data-logging-fields">
          <label>File format<select value={job.format} disabled={disabled}
            onChange={(event) => onChange({ ...job, format: event.target.value as 'json' | 'csv' })}>
            <option value="json">JSON</option><option value="csv">CSV</option></select></label>
          <label>Destination<select value={job.destination} disabled={disabled}
            onChange={(event) => {
              const destination = event.target.value as 'remote' | 'local_only'
              onChange({ ...job, destination,
                channel_ids: destination === 'local_only' ? [] : job.channel_ids })
            }}><option value="remote">Send using Data Channels</option>
            <option value="local_only">Local-only archive (no network)</option></select></label>
        </div>
        {job.destination === 'remote' && <fieldset className="job-channels"><legend>Send each file to</legend>
          {channels.length === 0 && <p>Create and save a Data Channel first.</p>}
          {channels.map((channel) => <label key={channel.id}><input type="checkbox"
            checked={job.channel_ids.includes(channel.id)} disabled={disabled || !channel.enabled}
            onChange={(event) => onChange({ ...job, channel_ids: event.target.checked
              ? [...job.channel_ids, channel.id]
              : job.channel_ids.filter((id) => id !== channel.id) })} />
            <span>{channel.name}<small>{channel.protocol.toUpperCase()} · {channel.enabled ? 'enabled' : 'disabled'}</small></span></label>)}
        </fieldset>}
        {job.destination === 'local_only' && <div className="local-only-note">
          No network connection is attempted. Files remain on this meter until an administrator deletes them.
        </div>}
      </section></li>
      <li><section className="job-review"><h4>4. Review</h4>
        <p>Every {duration(job.generation_interval_seconds)}, create one {job.format.toUpperCase()} file containing {job.selections.length} column{job.selections.length === 1 ? '' : 's'} in {job.generation_interval_seconds / job.row_interval_seconds} row{job.generation_interval_seconds / job.row_interval_seconds === 1 ? '' : 's'}.</p>
        <p>{job.destination === 'local_only' ? 'Keep it locally without sending.'
          : `Send it independently to ${job.channel_ids.length} selected channel${job.channel_ids.length === 1 ? '' : 's'}.`}</p>
      </section></li>
    </ol>
  </article>
}
