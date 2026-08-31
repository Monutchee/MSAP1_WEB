import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WaveformExplorer } from './WaveformExplorer'

afterEach(() => vi.unstubAllGlobals())

describe('Waveform explorer', () => {
  it('keeps the capture page visible when a selected file cannot be parsed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/waveforms')
        return new Response(JSON.stringify({
          running: true,
          active_session: false,
          sequence_gaps: 0,
          invalid_blocks: 0,
          transport_overrun_blocks: 0,
          pl_dropped_frames: 0,
          materialization_failures: 0,
          completed_sessions: 1,
          incomplete_sessions: 0,
          sessions: [{
            id: 23,
            state: 'complete',
            trigger_sequence: 100,
            first_sequence: 0,
            last_sequence: 127,
            trigger_tai_nanoseconds: 1,
            trigger_realtime_nanoseconds: 1_700_000_000_000_000_000,
            sample_rate_hz: 128_000,
            event_count: 1,
            origin: 'manual',
            decimation: 32,
            filename: 'waveform-23.mncwf',
            continuation_of_session_id: 0,
            master_session_id: 23,
            capture_uuid: 'capture-23',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
  })

  it('lists manual and mixed captures but hides PQ-only evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== '/api/v1/waveforms')
        throw new Error(`Unexpected request ${String(input)}`)
      const base = {
        state: 'complete', trigger_sequence: 100, first_sequence: 0,
        last_sequence: 127, trigger_tai_nanoseconds: 1,
        trigger_realtime_nanoseconds: 1_700_000_000_000_000_000,
        sample_rate_hz: 128_000, event_count: 1, decimation: 8,
        continuation_of_session_id: 0, capture_uuid: '',
      }
      return new Response(JSON.stringify({
        running: true, active_session: false, sequence_gaps: 0, invalid_blocks: 0,
        transport_overrun_blocks: 0, pl_dropped_frames: 0,
        materialization_failures: 0, completed_sessions: 3, incomplete_sessions: 0,
        sessions: [
          { ...base, id: 1, master_session_id: 1, origin: 'manual',
            filename: 'manual.mncwf' },
          { ...base, id: 2, master_session_id: 2, origin: 'mixed',
            filename: 'mixed.mncwf' },
          { ...base, id: 3, master_session_id: 3, origin: 'power_quality',
            filename: 'event.mncwf' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    render(<WaveformExplorer canDelete={false} onUnauthorized={() => undefined} />)
    expect(await screen.findByText('manual.mncwf')).toBeInTheDocument()
    expect(screen.getByText('mixed.mncwf')).toBeInTheDocument()
    expect(screen.queryByText('event.mncwf')).not.toBeInTheDocument()
    expect(screen.getByText('2 complete · 0 incomplete')).toBeInTheDocument()
  })
})
