import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api, type HarmonicSpectrum, type MeterReadingAttribute, type MeterReadings,
  type MeterTenMinuteResult,
} from '../api'
import { ReadingPage } from './ReadingPage'

function reading(key: string, sequence: number): MeterReadingAttribute {
  const units: Record<string, string> = {
    'power.active.total': 'W',
    'power.reactive.total': 'var',
    'power.apparent.total': 'VA',
    'power.factor.total': 'PF',
  }
  const values: Record<string, number> = {
    'sequence.voltage.positive.rms': 119.842,
    'sequence.voltage.negative.rms': 0.431,
    'sequence.voltage.zero.rms': 0.208,
    'sequence.current.positive.rms': 8.612,
    'sequence.current.negative.rms': 0.126,
    'sequence.current.zero.rms': 0.074,
    'unbalance.voltage': 0.36,
    'unbalance.current': 1.463,
    'unbalance.voltage.zero': 0.174,
    'unbalance.current.zero': 0.859,
  }
  const unit = units[key] ?? (key.startsWith('unbalance.') ? '%'
    : key.startsWith('sequence.current.') ? 'A' : 'V')
  return {
    key, unit,
    valid: true, value: values[key] ?? (key === 'power.reactive.total' ? -5 : 120),
    quality: 'valid', source_sequence: sequence,
  }
}

function record(sequence: number, generation: number, complete: boolean): MeterReadings {
  const attributes = [
    'voltage.ll.ab.rms', 'voltage.ll.bc.rms', 'voltage.ll.ca.rms',
    'power.active.total', 'power.reactive.total', 'power.apparent.total',
    'power.factor.total', 'unbalance.voltage', 'unbalance.current',
    'unbalance.voltage.zero', 'unbalance.current.zero',
    'sequence.voltage.positive.rms', 'sequence.voltage.negative.rms',
    'sequence.voltage.zero.rms', 'sequence.current.positive.rms',
    'sequence.current.negative.rms', 'sequence.current.zero.rms',
  ].map((key) => reading(key, sequence))
  return {
    sequence,
    configuration_generation: generation,
    sample_rate_hz: 32_000,
    block_sample_count: 3_200,
    status: 0,
    capture_frames: 1,
    header_errors: 0,
    fifo_overflows: 0,
    emit_drops: 0,
    result_drops: 0,
    frequency: {
      enabled: true, valid: true, reference_valid: true, out_of_range: false,
      timed_out: false, arithmetic_error: false, hz: 50, millihz: 50_000,
      period_q16_samples: 0, measurement_sequence: sequence, mode: 0,
      reference_channel: 0, cycles_used: 10,
    },
    channels: [], attributes, record_complete: complete,
    timing: {
      block_sequence: sequence, first_sample_index: 0, sample_count: 3_200,
      cycle_count: 10, nominal_frequency_hz: 50, cycle_locked: true,
      free_run_fallback: false, time_quality: 'synchronized',
      utc_start_nanoseconds: Date.UTC(2026, 7, 28, 12, 3, 20, 200) * 1_000_000,
      utc_uncertainty_nanoseconds: 250_000,
    },
  }
}

function displayedSequence() {
  return screen.getByText('Record sequence').closest('div')?.querySelector('dd')
}

function longInterval(
  sequence: number,
  generation: number,
  contaminated: boolean,
): MeterTenMinuteResult {
  const basic = record(sequence, generation, true)
  const attributes = basic.attributes!.map((attribute) => contaminated
    ? { ...attribute, valid: false, value: Number.NaN, quality: 'invalid' as const }
    : attribute)
  return {
    available: true, sequence, configuration_generation: generation,
    sample_rate_hz: 32_000, sample_count: 19_200_000, first_sample_index: 0,
    cycle_count: 10, nominal_frequency_hz: 50, arithmetic_error: false,
    time_quality: 'synchronized', age_ms: 10, channels: [], attributes,
    open_interval: false, non_normative: false, source_interval_count: 3000,
    first_source_sequence: 1, last_source_sequence: 3000,
    expected_end_sample_index: 19_200_000, overshoot_samples: 0,
    elapsed_milliseconds: 600_000, time_aligned: !contaminated,
    contaminated, boundary_valid: true, record_complete: true,
    utc_start_nanoseconds: Date.UTC(2026, 8, 1, 16, sequence * 10) * 1_000_000,
    utc_uncertainty_nanoseconds: 250_000,
  }
}

function harmonicSpectrum(
  sequence: number,
  overrides: Partial<HarmonicSpectrum> = {},
): HarmonicSpectrum {
  return {
    running: true, available: true, records: 42, families: sequence,
    incomplete_families: 0, period: 'minutes_10', sequence,
    configuration_generation: 7, sample_rate_hz: 32_000,
    sample_count: 19_200_000, first_sample: 0,
    measured_frequency_millihz: 50_000, qualified_max_order: 127,
    nominal_frequency_hz: 50, cycle_count: 10, filter_profile_id: 1,
    valid_mask: 0x7f, status: 0, emit_drops: 0, result_drops: 0,
    target_sample: 19_200_000, contributors: 3000, overshoot_samples: 0,
    first_source_sequence: 1, last_source_sequence: 3000,
    time_aligned: true, contaminated: false, interval_valid: true,
    arithmetic_error: false, grid_locked: true, conditioner_valid: true,
    fft_valid: true, full_range: true, first_after_discontinuity: false,
    rate_limited: false,
    channels: [{
      channel: 6, name: 'Va', unit: 'V',
      orders: [{
        order: 1, magnitude_micro_units: 120_000_000, magnitude: 120,
        magnitude_valid: true, angle_millidegrees: 0, angle_degrees: 0,
        angle_valid: true,
      }],
    }],
    ...overrides,
  }
}

describe('Reading page coherent record behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('retains an incomplete same-generation update and clears it on generation change', () => {
    const { rerender } = render(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    expect(displayedSequence()).toHaveTextContent('41')
    expect(screen.getByText('Finalized')).toBeInTheDocument()
    expect(screen.getByText('2026-08-28 12:03:20.200 UTC')).toBeInTheDocument()

    rerender(<ReadingPage readings={record(42, 7, false)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    expect(displayedSequence()).toHaveTextContent('41')

    rerender(<ReadingPage readings={record(1, 8, false)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    expect(displayedSequence()).toHaveTextContent('—')
    expect(screen.getByText(/Waiting for 10\/12-cycle finalized data/)).toBeInTheDocument()
  })

  it('exposes the reamped navigation and a keyboard-operable interval control', () => {
    render(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    expect(screen.getByRole('button', { name: 'Power' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Phasor & Unbalance' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sequence' })).toBeInTheDocument()
    const interval = screen.getByRole('combobox', { name: 'Measurement interval' })
    interval.focus()
    expect(interval).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Phasor Angle' })).not.toBeInTheDocument()
  })

  it('shows an operator sequence view without inventing unpublished angles', () => {
    const { rerender } = render(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sequence' }))

    expect(screen.getByRole('heading', { name: 'Sequence balance' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Star (wye)' })).toBeInTheDocument()
    expect(screen.getByText('Nominal reference: line-to-neutral (L-N)')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Voltage sequence magnitudes' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Current sequence magnitudes' })).toBeInTheDocument()
    expect(screen.getByRole('meter', {
      name: 'V₂ / V₁ negative-sequence ratio',
    })).toHaveAttribute('aria-valuenow', '0.36')
    expect(screen.getByText('Why there is no polar sequence plot')).toBeInTheDocument()
    expect(screen.getByText(/does not reconstruct or invent sequence angles/)).toBeInTheDocument()
    expect(screen.getByText(/Advanced sequence details/).closest('details')).not.toHaveAttribute('open')

    rerender(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="delta" />)
    expect(screen.getByRole('heading', { name: 'Delta' })).toBeInTheDocument()
    expect(screen.getByText('Nominal reference: line-to-line (L-L)')).toBeInTheDocument()
    expect(screen.getByText(/measured line-side residuals/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Phasor & Unbalance' }))
    expect(screen.getByText('Vab')).toBeInTheDocument()
    expect(screen.getByText('Line voltage AB')).toBeInTheDocument()
    expect(screen.getByText('120 V L-L nominal')).toBeInTheDocument()
  })

  it('distinguishes invalid sequence values from unavailable fields', () => {
    const degraded = record(41, 7, true)
    degraded.attributes = degraded.attributes?.flatMap((candidate) => {
      if (candidate.key === 'sequence.current.zero.rms') return []
      if (candidate.key === 'sequence.voltage.negative.rms') return [{
        ...candidate, valid: false, value: Number.NaN, quality: 'invalid' as const,
      }]
      return [candidate]
    })
    render(<ReadingPage readings={degraded} onUnauthorized={() => undefined}
      systemNominalVoltage={120} measurementTopology="wye" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sequence' }))

    expect(screen.getByRole('img', {
      name: 'Negative sequence V₂ invalid',
    })).toBeInTheDocument()
    expect(screen.getByRole('img', {
      name: 'Zero sequence I₀ unavailable',
    })).toBeInTheDocument()
    expect(screen.getByText('Invalid values present')).toBeInTheDocument()
  })

  it('waits for a clean long interval and retains the previous result after rejection', async () => {
    let latest = longInterval(1, 7, true)
    vi.spyOn(api, 'meterTenMinute').mockImplementation(async () => latest)

    const { rerender } = render(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} measurementTopology="wye" />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Measurement interval' }), {
      target: { value: 'min10' },
    })

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Waiting for the first clean finalized 10-minute interval')
    expect(screen.queryByText('Finalized')).not.toBeInTheDocument()
    expect(displayedSequence()).toHaveTextContent('—')
    expect(screen.queryByText('Invalid values present')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Phasor & Unbalance' }))
    expect(screen.getByText(/Waiting for 10-minute finalized phasors/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sequence' }))
    expect(screen.getByText(/Waiting for 10-minute finalized sequence data/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Overview' }))

    latest = longInterval(2, 7, false)
    fireEvent.change(screen.getByRole('combobox', { name: 'Measurement interval' }), {
      target: { value: 'basic' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Measurement interval' }), {
      target: { value: 'min10' },
    })
    await waitFor(() => expect(displayedSequence()).toHaveTextContent('2'))
    expect(screen.getByText('Finalized')).toBeInTheDocument()

    latest = longInterval(3, 7, true)
    fireEvent.change(screen.getByRole('combobox', { name: 'Measurement interval' }), {
      target: { value: 'basic' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Measurement interval' }), {
      target: { value: 'min10' },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Latest 10-minute interval rejected')
    expect(screen.getByText('Previous finalized')).toBeInTheDocument()
    expect(displayedSequence()).toHaveTextContent('2')

    rerender(<ReadingPage readings={record(41, 7, true)} onUnauthorized={() => undefined}
      systemNominalVoltage={120} measurementTopology="wye" acquisitionAvailable={false} />)
    expect(displayedSequence()).toHaveTextContent('—')
  })

  it('shows two-hour startup data as priming rather than finalized invalid values', async () => {
    vi.spyOn(api, 'meterTwoHour').mockResolvedValue(longInterval(1, 7, true))
    render(<ReadingPage readings={record(41, 7, true)} onUnauthorized={() => undefined}
      systemNominalVoltage={120} measurementTopology="wye" />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Measurement interval' }), {
      target: { value: 'hour2' },
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Waiting for the first clean finalized 2-hour interval')
    expect(screen.queryByText('Invalid values present')).not.toBeInTheDocument()
  })

  it('primes, commits, and retains long harmonic families without presenting rejected data as fresh', async () => {
    let latest = harmonicSpectrum(1, { contaminated: true, interval_valid: false })
    vi.spyOn(api, 'meterHarmonics').mockImplementation(async (period) => period === 'minutes_10'
      ? latest : harmonicSpectrum(10, { period: 'cycles_150_180' }))
    render(<ReadingPage readings={record(41, 7, true)} onUnauthorized={() => undefined}
      systemNominalVoltage={120} measurementTopology="wye" />)
    fireEvent.click(screen.getByRole('button', { name: 'Harmonics' }))
    await waitFor(() => expect(api.meterHarmonics).toHaveBeenCalledWith('cycles_150_180'))
    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), {
      target: { value: 'minutes_10' },
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Waiting for the first clean finalized 10-minute interval')

    latest = harmonicSpectrum(2)
    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), {
      target: { value: 'cycles_150_180' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), {
      target: { value: 'minutes_10' },
    })
    await waitFor(() => expect(screen.getByText('Family 2')).toBeInTheDocument())

    latest = harmonicSpectrum(3, { contaminated: true, interval_valid: false })
    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), {
      target: { value: 'cycles_150_180' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), {
      target: { value: 'minutes_10' },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('Latest harmonic interval rejected')
    expect(screen.getByText('Family 2 · latest rejected')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Showing family 2 as stale')
  })

  it('replaces harmonic priming guidance with an actionable nominal mismatch warning', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
    const mismatched = record(41, 7, true)
    mismatched.timing!.nominal_frequency_hz = 60
    mismatched.frequency.hz = 49.998
    mismatched.frequency.millihz = 49_998

    const { rerender } = render(<ReadingPage readings={mismatched}
      onUnauthorized={() => undefined} systemNominalVoltage={120}
      measurementTopology="wye" canConfigure />)
    fireEvent.click(screen.getByRole('button', { name: 'Harmonics' }))

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Configured nominal is 60 Hz; measured grid is 49.998 Hz. Harmonic windows are intentionally rejected—select 50 Hz under Configuration → Meter.')
    expect(screen.getByText('Harmonic windows intentionally rejected')).toBeInTheDocument()
    expect(screen.queryByText('No complete spectrum yet')).not.toBeInTheDocument()

    const corrected = record(42, 8, true)
    corrected.timing!.nominal_frequency_hz = 50
    corrected.frequency.hz = 49.998
    corrected.frequency.millihz = 49_998
    act(() => rerender(<ReadingPage readings={corrected}
      onUnauthorized={() => undefined} systemNominalVoltage={120}
      measurementTopology="wye" canConfigure />))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('No complete spectrum yet')).toBeInTheDocument()
  })
})
