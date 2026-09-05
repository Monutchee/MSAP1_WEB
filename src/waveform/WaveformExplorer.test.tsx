import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WaveformOrigin, WaveformSession } from '../api'
import { WaveformExplorer } from './WaveformExplorer'

function session(id: number, origin: WaveformOrigin, filename = `${origin}-${id}.mncwf`): WaveformSession {
  return {
    id,
    state: 'complete',
    trigger_sequence: 100,
    first_sequence: 0,
    last_sequence: 127,
    trigger_tai_nanoseconds: 1,
    trigger_realtime_nanoseconds: 1_700_000_000_000_000_000,
    sample_rate_hz: 128_000,
    event_count: origin === 'power_quality' || origin === 'mixed' ? 1 : 0,
    origin,
    decimation: 8,
    filename,
    continuation_of_session_id: 0,
    master_session_id: id,
    capture_uuid: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
  format_version: 5,
  compression: 'zstd_chunks',
  stored_bytes: 1024,
  logical_sample_bytes: 2048,
  }
}

function waveformResponse(sessions: WaveformSession[], total = sessions.length,
  next: number | null = null) {
  return {
    running: true,
    active_session: false,
    sample_rate_hz: 128_000,
    transport_ring_blocks: 32,
    blocks: 1,
    frames: 128,
    bytes: 4096,
    sequence_gaps: 0,
    invalid_blocks: 0,
    transport_overrun_blocks: 0,
    pl_dropped_frames: 0,
    materialization_failures: 0,
    max_capture_frames: 1_000_000,
    history_oldest_sequence: 1,
    history_latest_sequence: 128,
    history_capacity_frames: 1_000_000,
    completed_sessions: total,
    incomplete_sessions: 0,
  archive_limit_bytes: 8 * 1024 * 1024 * 1024,
  archive_stored_bytes: total * 1024,
  expired_sessions: 0,
  retention_failures: 0,
    archive_discovery: {
      state: 'complete', scanned_files: total, total_files: total, rejected_files: 0,
    },
    page: {
      origin: 'all', limit: 16, total_sessions: total,
      completed_sessions: total, incomplete_sessions: 0, active_sessions: 0,
      returned_sessions: sessions.length, next_before_session_id: next,
    },
    export_formats: ['mncwf'],
    sessions,
  }
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('Waveform explorer', () => {
  it('keeps the capture page visible when a selected file cannot be parsed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/waveforms?origin=all&limit=16')
        return json(waveformResponse([session(23, 'manual', 'waveform-23.mncwf')]))
      if (url === '/protected/waveforms/view/waveform-23.mncwf')
        return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 })
      throw new Error(`Unexpected request ${url}`)
    }))

    render(<WaveformExplorer canDelete={false} onUnauthorized={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: 'View waveform' }))

    expect(await screen.findByText(/Invalid header range in waveform file/))
      .toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Saved captures' })).toBeInTheDocument()
    expect(screen.getByText('waveform-23.mncwf')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Download MNCWF' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export…' })).toBeEnabled()
  })

  it('defaults to All, labels every origin, and applies server origin filters', async () => {
    const all = [
      session(4, 'manual'), session(3, 'power_quality'),
      session(2, 'mixed'), session(1, 'legacy'),
    ]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/waveforms?origin=all&limit=16')
        return json(waveformResponse(all))
      if (url === '/api/v1/waveforms?origin=manual&limit=16')
        return json({ ...waveformResponse([all[0], all[2]], 2),
          page: { ...waveformResponse([], 2).page, origin: 'manual',
            total_sessions: 2, completed_sessions: 2 } })
      if (url === '/api/v1/waveforms?origin=power_quality&limit=16')
        return json({ ...waveformResponse([all[1], all[2]], 2),
          page: { ...waveformResponse([], 2).page, origin: 'power_quality',
            total_sessions: 2, completed_sessions: 2 } })
      throw new Error(`Unexpected request ${url}`)
    }))

    render(<WaveformExplorer canDelete onUnauthorized={() => undefined} />)
    const filter = await screen.findByRole('combobox', {
      name: 'Filter captures by trigger type',
    })
    expect(filter).toHaveValue('all')
    for (const label of [
      'Manual trigger', 'PQ event trigger', 'Manual + PQ event',
      'Legacy / unknown trigger',
    ]) expect(screen.getByLabelText(`Trigger origin: ${label}`)).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Select session 4'))
    expect(screen.getByRole('button', { name: 'Delete selected (1)' })).toBeEnabled()
    fireEvent.change(filter, { target: { value: 'manual' } })
    expect(await screen.findByText('manual-4.mncwf')).toBeInTheDocument()
    expect(screen.getByText('mixed-2.mncwf')).toBeInTheDocument()
    expect(screen.queryByText('power_quality-3.mncwf')).not.toBeInTheDocument()
    expect(screen.queryByText('legacy-1.mncwf')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete selected (0)' })).toBeDisabled()

    fireEvent.change(filter, { target: { value: 'power_quality' } })
    expect(await screen.findByText('power_quality-3.mncwf')).toBeInTheDocument()
    expect(screen.getByText('mixed-2.mncwf')).toBeInTheDocument()
    expect(screen.queryByText('manual-4.mncwf')).not.toBeInTheDocument()
    expect(screen.queryByText('legacy-1.mncwf')).not.toBeInTheDocument()
  })

  it('loads older captures, shows matching totals, and warns before PQ deletion', async () => {
    const newest = [session(20, 'manual'), session(19, 'power_quality')]
    const older = session(18, 'legacy')
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/waveforms?origin=all&limit=16')
        return json(waveformResponse(newest, 3, 19))
      if (url === '/api/v1/waveforms?origin=all&before_session_id=19&limit=16')
        return json(waveformResponse([older], 3))
      throw new Error(`Unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<WaveformExplorer canDelete onUnauthorized={() => undefined} />)
    expect(await screen.findByText(/2 of 3 shown/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load older captures' }))
    expect(await screen.findByText('legacy-18.mncwf')).toBeInTheDocument()
    expect(screen.getByText(/3 of 3 shown/)).toBeInTheDocument()

    const pqArticle = screen.getByText('power_quality-19.mncwf').closest('article')
    expect(pqArticle).not.toBeNull()
    fireEvent.click(within(pqArticle as HTMLElement).getByRole('button', { name: 'Delete' }))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(
      'Linked PQ event evidence will become unavailable'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/waveforms?origin=all&before_session_id=19&limit=16',
      expect.anything(),
    ))
  })
})
