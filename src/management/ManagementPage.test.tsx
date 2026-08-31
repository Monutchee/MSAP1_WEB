import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagementPage } from './ManagementPage'

function waveformStatus(sessionCount: number) {
  return {
    running: true,
    active_session: false,
    sample_rate_hz: 128_000,
    transport_ring_blocks: 32,
    blocks: 1,
    frames: 256,
    bytes: 8192,
    invalid_blocks: 0,
    sequence_gaps: 0,
    transport_overrun_blocks: 0,
    materialization_failures: 0,
    pl_dropped_frames: 0,
    max_capture_frames: 1_000_000,
    history_oldest_sequence: 1,
    history_latest_sequence: 256,
    history_capacity_frames: 1_000_000,
    completed_sessions: sessionCount,
    incomplete_sessions: 0,
    export_formats: ['mncwf'],
    sessions: Array.from({ length: sessionCount }, (_, index) => ({
      id: index + 1,
      state: 'complete',
      trigger_sequence: 100,
      first_sequence: 1,
      last_sequence: 256,
      trigger_tai_nanoseconds: 0,
      trigger_realtime_nanoseconds: 1_700_000_000_000_000_000,
      sample_rate_hz: 128_000,
      event_count: 1,
      origin: 'manual',
      decimation: 32,
      filename: `manual-${index + 1}.mncwf`,
      continuation_of_session_id: 0,
      master_session_id: index + 1,
      capture_uuid: `capture-${index + 1}`,
    })),
  }
}

describe('Management page', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('confirms and separates historian, event, and waveform deletion', async () => {
    let eventCount = 3
    let waveformCount = 2
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/v1/developer/database/maintenance')
        return new Response(JSON.stringify({}), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      if (url === '/api/v1/developer/database')
        return new Response(JSON.stringify({
          stream: {
            healthy: true, durability: true, oldest_cursor: 1,
            newest_cursor: 12, record_count: 12, storage_bytes: 4096,
            session_start_cursor: 1, dropped_unacknowledged_records: 0,
            consumers: [],
          },
          historian: {
            healthy: true, migration_in_progress: false,
            backfill_incomplete: false, acknowledged_cursor: 12,
            oldest_available_stream_cursor: 1, newest_stream_cursor: 12,
            lag_records: 0, block_count: 7, storage_bytes: 8192,
            power_quality_event_count: eventCount, datasets: [],
          },
          policies: {},
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/api/v1/meter/power-quality/events' && init?.method === 'DELETE') {
        const deleted = eventCount
        eventCount = 0
        return new Response(JSON.stringify({ deleted }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === '/api/v1/waveforms' && init?.method === 'DELETE') {
        waveformCount = 0
        return new Response(JSON.stringify(waveformStatus(0)), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === '/api/v1/waveforms')
        return new Response(JSON.stringify(waveformStatus(waveformCount)), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<ManagementPage onUnauthorized={() => undefined} />)
    expect(await screen.findByText('3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Clear all data logs' }))
    let dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear all data logs' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === '/api/v1/developer/database/maintenance' &&
      init?.method === 'POST')).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Clear all PQ events' }))
    dialog = screen.getByRole('alertdialog')
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === '/api/v1/meter/power-quality/events' &&
      init?.method === 'DELETE')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear all PQ events' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === '/api/v1/meter/power-quality/events' &&
      init?.method === 'DELETE')).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Clear all waveform data' }))
    dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear all waveforms' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url) === '/api/v1/waveforms' && init?.method === 'DELETE')).toBe(true))

    const eventDelete = fetchMock.mock.calls.find(([url, init]) =>
      String(url) === '/api/v1/meter/power-quality/events' && init?.method === 'DELETE')
    expect(JSON.parse(String(eventDelete?.[1]?.body))).toEqual({
      event_ids: [], all: true, confirmed: true,
    })
    const waveformDelete = fetchMock.mock.calls.find(([url, init]) =>
      String(url) === '/api/v1/waveforms' && init?.method === 'DELETE')
    expect(JSON.parse(String(waveformDelete?.[1]?.body))).toEqual({
      session_id: 0, all: true, confirmed: true,
    })
  })
})
