import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

  it('opens a waveform requested by the event catalogue in the same viewer path', async () => {
    const consumed = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/waveforms')
        return new Response(JSON.stringify({
          running: true, active_session: false, sequence_gaps: 0, invalid_blocks: 0,
          transport_overrun_blocks: 0, pl_dropped_frames: 0, materialization_failures: 0,
          completed_sessions: 1, incomplete_sessions: 0,
          sessions: [{ id: 24, state: 'complete', trigger_sequence: 100,
            first_sequence: 0, last_sequence: 127, trigger_tai_nanoseconds: 1,
            trigger_realtime_nanoseconds: 1_700_000_000_000_000_000,
            sample_rate_hz: 128_000, event_count: 1, decimation: 8,
            filename: 'event-24.mncwf', continuation_of_session_id: 0,
            master_session_id: 24, capture_uuid: 'capture-24' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (url === '/protected/waveforms/view/event-24.mncwf')
        return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 })
      throw new Error(`Unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<WaveformExplorer canDelete={false} onUnauthorized={() => undefined}
      initialFilename="event-24.mncwf" onInitialFilenameConsumed={consumed} />)

    expect(await screen.findByText(/Invalid header range in waveform file/))
      .toBeInTheDocument()
    await waitFor(() => expect(consumed).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledWith('/protected/waveforms/view/event-24.mncwf',
      expect.anything())
  })
})
