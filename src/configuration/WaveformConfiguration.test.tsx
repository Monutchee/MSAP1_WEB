import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WaveformConfiguration } from './WaveformConfiguration'

const product = {
  waveform: {
    default_pretrigger_ms: 1000, default_posttrigger_ms: 2000, default_decimation: 2,
    archive_limit_gib: 8,
    station_id: '', station_name: '', site_id: '', site_name: '',
    circuit_id: '', circuit_name: '', device_serial: '', calibration_id: '',
    calibration_status: 'unknown',
  },
  metering: { events: { sentinel: 'keep-pq-policy' } },
  adc: { sentinel: 'keep-adc' },
}

afterEach(() => vi.unstubAllGlobals())

describe('Waveform configuration', () => {
  it('saves optional identity and archive limit while preserving latest capture defaults and PQ settings', async () => {
    let saved: typeof product | undefined
    let reads = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body)) as typeof product
      const settings = structuredClone(saved ?? product)
      if (!saved && ++reads > 1) settings.waveform.default_decimation = 8
      return new Response(JSON.stringify({ settings }), { status: 200 })
    }))
    render(<WaveformConfiguration onUnauthorized={() => undefined} />)
    fireEvent.change(await screen.findByLabelText('Station ID'), { target: { value: 'STN-04' } })
    fireEvent.change(screen.getByLabelText(/Waveform archive limit/), { target: { value: '12' } })
    expect(screen.getByLabelText('Calibration ID')).not.toBeRequired()
    fireEvent.click(screen.getByRole('button', { name: 'Apply and save' }))
    expect(await screen.findByText(/Applied and saved/)).toBeInTheDocument()
    expect(saved?.waveform).toEqual({ ...product.waveform,
      station_id: 'STN-04', archive_limit_gib: 12, default_decimation: 8,
    })
    expect(saved?.metering).toEqual(product.metering)
    expect(saved?.adc).toEqual(product.adc)
  })

  it('allows clearing identity with unknown calibration and requires an ID for a known status', async () => {
    let saved: typeof product | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body)) as typeof product
      return new Response(JSON.stringify({ settings: saved ?? { ...product,
        waveform: { ...product.waveform, station_name: 'Old station' },
      } }), { status: 200 })
    }))
    render(<WaveformConfiguration onUnauthorized={() => undefined} />)
    fireEvent.change(await screen.findByLabelText('Station name'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Calibration status'), { target: { value: 'valid' } })
    expect(screen.getByLabelText('Calibration ID')).toBeRequired()
    fireEvent.change(screen.getByLabelText('Calibration status'), { target: { value: 'unknown' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply and save' }))
    expect(await screen.findByText(/Applied and saved/)).toBeInTheDocument()
    expect(saved?.waveform).toEqual(product.waveform)
  })

  it('handles an expired login without exposing editable settings', async () => {
    const unauthorized = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    render(<WaveformConfiguration onUnauthorized={unauthorized} />)
    await vi.waitFor(() => expect(unauthorized).toHaveBeenCalledOnce())
    expect(screen.queryByRole('button', { name: 'Apply and save' })).not.toBeInTheDocument()
  })
})
