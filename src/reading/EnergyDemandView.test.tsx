import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnergyDemandView, formatEnergyValue, formatExactInteger } from './EnergyDemandView'

const group = (base: string) => ({
  phase_a: base,
  phase_b: '2',
  phase_c: '3',
  total: '4',
})

const energy = {
  active_import_uwh: group('9007199254740993'),
  active_export_uwh: group('5'),
  apparent_uvah: group('6'),
  reactive_quadrant_i_uvarh: group('11'),
  reactive_quadrant_ii_uvarh: group('12'),
  reactive_quadrant_iii_uvarh: group('13'),
  reactive_quadrant_iv_uvarh: group('14'),
  session_id: '18446744073709551614',
  last_sample_index: '88',
  accepted_samples: '77',
  skipped_samples: '0',
  accepted_blocks: 5,
  skipped_blocks: 0,
  reset_epoch: '8',
  last_durable_update_nanoseconds: '1787933000000000000',
  quality: 'valid',
  incomplete_accumulation: false,
  saturated: false,
  discontinuity: false,
}

const demand = {
  current_active_uw: group('-9007199254740993'),
  import_peak_uw: group('15'),
  export_peak_uw: group('16'),
  import_peak_sample: group('17'),
  export_peak_sample: group('18'),
  session_id: '18446744073709551614',
  last_sample_index: '89',
  interval_target_sample: '90',
  source_interval_count: 1,
  source_status: 0,
  peak_reset_epoch: '9',
  last_durable_update_nanoseconds: '1787933000000000001',
  quality: 'valid',
  time_aligned: true,
  contaminated: false,
  boundary_valid: true,
  incomplete_accumulation: false,
  saturated: false,
}

afterEach(() => vi.unstubAllGlobals())

describe('Energy & Demand view', () => {
  it('formats counters and session identifiers through BigInt', () => {
    expect(formatExactInteger('9007199254740993')).toBe('9,007,199,254,740,993')
    expect(formatExactInteger('-9007199254740993')).toBe('-9,007,199,254,740,993')
    expect(formatEnergyValue('9007199254740993', 'Wh')).toBe('9,007,199,254.740993')
    expect(formatEnergyValue('9007199254740993', 'kWh')).toBe('9,007,199.254740993')
    expect(formatEnergyValue('9007199254740993', 'MWh')).toBe('9,007.199254740993')
  })

  it('renders every quadrant with explicit P/Q signs and admin reset controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      return new Response(JSON.stringify(url.endsWith('/energy') ? energy : demand), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    render(<EnergyDemandView canReset onUnauthorized={() => undefined} />)

    expect(await screen.findByRole('heading', { name: 'Four-quadrant ledger' })).toBeInTheDocument()
    expect(screen.getByText('P ≥ 0 · Q₁ > 0')).toBeInTheDocument()
    expect(screen.getByText('P < 0 · Q₁ > 0')).toBeInTheDocument()
    expect(screen.getByText('P < 0 · Q₁ < 0')).toBeInTheDocument()
    expect(screen.getByText('P ≥ 0 · Q₁ < 0')).toBeInTheDocument()
    const unit = screen.getByRole('combobox', { name: 'Energy display unit' })
    expect(unit).toHaveValue('kWh')
    expect(screen.getByText('9,007,199.254740993')).toBeInTheDocument()
    expect(screen.getAllByText('kWh').length).toBeGreaterThan(1)
    expect(screen.getAllByText('kVAh').length).toBeGreaterThan(0)
    expect(screen.getAllByText('kvarh').length).toBeGreaterThan(0)
    expect(screen.queryByText('µWh')).not.toBeInTheDocument()
    fireEvent.change(unit, { target: { value: 'Wh' } })
    expect(screen.getByText('9,007,199,254.740993')).toBeInTheDocument()
    expect(screen.getAllByText('18,446,744,073,709,551,614')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Reset all energy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset demand peaks' })).toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it('treats the missing first demand checkpoint as warm-up, not a durable-data fault', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString().endsWith('/energy')) {
        return new Response(JSON.stringify(energy), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: 'no durable DEMAND checkpoint exists' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    }))

    render(<EnergyDemandView canReset onUnauthorized={() => undefined} />)

    expect(await screen.findByText('Demand warm-up')).toBeInTheDocument()
    expect(screen.queryByText('Some durable values are unavailable')).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for a completed UTC interval')).toBeInTheDocument()
  })
})
