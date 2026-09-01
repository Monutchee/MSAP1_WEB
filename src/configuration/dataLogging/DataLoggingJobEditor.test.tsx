import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DataChannelSettings, DataLoggingJobSettings, MeterAttributeCatalog,
} from '../../api'
import { DataLoggingJobEditor } from './DataLoggingJobEditor'

const catalog: MeterAttributeCatalog = {
  usage: 'historian',
  periods: [
    { id: 'basic', label: 'Basic 10/12-cycle',
      attributes: ['frequency', 'voltage.ln.a.rms'] },
    { id: 'seconds_10', label: 'IEC frequency 10-second', attributes: ['frequency'] },
    { id: 'minutes_10', label: '10 minute', attributes: ['voltage.ln.a.rms'] },
  ],
  attributes: [
    { id: 'frequency', label: 'Frequency', group: 'frequency', unit: 'Hz',
      value_kind: 'linear', search_aliases: ['hertz'],
      calculations: ['minimum', 'maximum', 'average', 'last'],
      periods: ['basic', 'seconds_10'] },
    { id: 'voltage.ln.a.rms', label: 'Line voltage A', group: 'voltage_ln_rms',
      unit: 'V', value_kind: 'linear', search_aliases: ['phase a'],
      calculations: ['minimum', 'maximum', 'average', 'last'],
      periods: ['basic', 'minutes_10'] },
  ],
}

const channel: DataChannelSettings = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Office HTTPS', enabled: true,
  protocol: 'https', host: 'collector.test', port: 0, http_path: '/meter',
  remote_directory: '/', authentication: 'none', username: '',
  connect_timeout_seconds: 10, transfer_timeout_seconds: 120,
  use_system_ca: true, use_uploaded_ca: false, use_client_certificate: false,
  insecure_transport_acknowledged: false,
}
const secondChannel: DataChannelSettings = {
  ...channel, id: '33333333-3333-4333-8333-333333333333', name: 'Office SFTP',
  protocol: 'sftp', host: 'sftp.test', remote_directory: '/incoming',
}

function initialJob(overrides: Partial<DataLoggingJobSettings> = {}): DataLoggingJobSettings {
  return { id: '22222222-2222-4222-8222-222222222222', name: 'Five minute',
    enabled: true, revision: 1, source_period: 'basic',
    generation_interval_seconds: 300, row_interval_seconds: 60,
    selections: [{ attribute: 'voltage.ln.a.rms', calculation: 'minimum' }],
    format: 'json', destination: 'remote', channel_ids: [channel.id], ...overrides }
}

function Harness({ start = initialJob(), changed = () => undefined,
  channels = [channel] }: {
  start?: DataLoggingJobSettings
  changed?: (job: DataLoggingJobSettings) => void
  channels?: DataChannelSettings[]
}) {
  const [job, setJob] = useState(start)
  return <DataLoggingJobEditor job={job} catalog={catalog} channels={channels}
    demandWindowSeconds={600} disabled={false}
    onChange={(next) => { setJob(next); changed(next) }} onRemove={() => undefined} />
}

describe('DataLoggingJobEditor', () => {
  afterEach(() => vi.restoreAllMocks())

  it('allows several calculations for one attribute', () => {
    const changed = vi.fn()
    render(<Harness changed={changed} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'average' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'maximum' }))
    const latest = changed.mock.calls.at(-1)?.[0] as DataLoggingJobSettings
    expect(latest.selections).toEqual(expect.arrayContaining([
      { attribute: 'voltage.ln.a.rms', calculation: 'minimum' },
      { attribute: 'voltage.ln.a.rms', calculation: 'average' },
      { attribute: 'voltage.ln.a.rms', calculation: 'maximum' },
    ]))
    expect(screen.getByText(/containing 3 columns/)).toBeInTheDocument()
  })

  it('offers only source-compatible intervals and makes Local-only exclusive', () => {
    const changed = vi.fn()
    render(<Harness start={initialJob({ source_period: 'minutes_10',
      generation_interval_seconds: 1800, row_interval_seconds: 600 })}
      changed={changed} />)
    const generation = screen.getByRole('combobox', { name: 'Generate one file every' })
    expect(within(generation).getByRole('option', { name: '10 minutes' })).toBeInTheDocument()
    expect(within(generation).queryByRole('option', { name: '15 minutes' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Destination' }),
      { target: { value: 'local_only' } })
    const latest = changed.mock.calls.at(-1)?.[0] as DataLoggingJobSettings
    expect(latest.destination).toBe('local_only')
    expect(latest.channel_ids).toEqual([])
    expect(screen.getByText(/No network connection is attempted/)).toBeInTheDocument()
  })

  it('allows ten-second files and rows for the standardized frequency product', () => {
    render(<Harness start={initialJob({
      source_period: 'seconds_10', generation_interval_seconds: 10,
      row_interval_seconds: 10,
      selections: [{ attribute: 'frequency', calculation: 'last' }],
    })} />)

    const generation = screen.getByRole('combobox', { name: 'Generate one file every' })
    const rows = screen.getByRole('combobox', { name: 'One output row every' })
    expect(within(generation).getByRole('option', { name: '10 seconds' })).toBeInTheDocument()
    expect(within(rows).getByRole('option', { name: '10 seconds' })).toBeInTheDocument()
    expect(within(rows).queryByRole('option', { name: '3 seconds' })).not.toBeInTheDocument()
  })

  it('requires confirmation before a period change removes attributes', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const changed = vi.fn()
    render(<Harness start={initialJob({ selections: [
      { attribute: 'frequency', calculation: 'last' },
    ] })} changed={changed} />)
    const period = screen.getByRole('combobox', { name: 'Source period' })
    fireEvent.change(period, { target: { value: 'minutes_10' } })
    expect(changed).not.toHaveBeenCalled()
    expect(period).toHaveValue('basic')
    fireEvent.change(period, { target: { value: 'minutes_10' } })
    const latest = changed.mock.calls.at(-1)?.[0] as DataLoggingJobSettings
    expect(latest.source_period).toBe('minutes_10')
    expect(latest.selections).toEqual([])
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('selects several remote channels independently', () => {
    const changed = vi.fn()
    render(<Harness channels={[channel, secondChannel]} changed={changed} />)
    const sftp = screen.getByRole('checkbox', { name: /Office SFTP/ })
    fireEvent.click(sftp)
    const latest = changed.mock.calls.at(-1)?.[0] as DataLoggingJobSettings
    expect(latest.channel_ids).toEqual([channel.id, secondChannel.id])
    expect(screen.getByText(/2 selected channels/)).toBeInTheDocument()
  })
})
