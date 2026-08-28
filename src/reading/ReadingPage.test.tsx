import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { MeterReadingAttribute, MeterReadings } from '../api'
import { ReadingPage } from './ReadingPage'

function reading(key: string, sequence: number): MeterReadingAttribute {
  const units: Record<string, string> = {
    'power.active.total': 'W',
    'power.reactive.total': 'var',
    'power.apparent.total': 'VA',
    'power.factor.total': 'PF',
  }
  return {
    key, unit: units[key] ?? (key.startsWith('unbalance.') ? '%' : 'V'),
    valid: true, value: key === 'power.reactive.total' ? -5 : 120,
    quality: 'valid', source_sequence: sequence,
  }
}

function record(sequence: number, generation: number, complete: boolean): MeterReadings {
  const attributes = [
    'voltage.ll.ab.rms', 'voltage.ll.bc.rms', 'voltage.ll.ca.rms',
    'power.active.total', 'power.reactive.total', 'power.apparent.total',
    'power.factor.total', 'unbalance.voltage', 'unbalance.current',
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

describe('Reading page coherent record behavior', () => {
  it('retains an incomplete same-generation update and clears it on generation change', () => {
    const { rerender } = render(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} />)
    expect(displayedSequence()).toHaveTextContent('41')
    expect(screen.getByText('Finalized')).toBeInTheDocument()
    expect(screen.getByText('2026-08-28 12:03:20.200 UTC')).toBeInTheDocument()

    rerender(<ReadingPage readings={record(42, 7, false)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} />)
    expect(displayedSequence()).toHaveTextContent('41')

    rerender(<ReadingPage readings={record(1, 8, false)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} />)
    expect(displayedSequence()).toHaveTextContent('—')
    expect(screen.getByText(/Waiting for 10\/12-cycle finalized data/)).toBeInTheDocument()
  })

  it('exposes the reamped navigation and a keyboard-operable interval control', () => {
    render(<ReadingPage readings={record(41, 7, true)}
      onUnauthorized={() => undefined} systemNominalVoltage={120} />)
    expect(screen.getByRole('button', { name: 'Power' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Phasor & Unbalance' })).toBeInTheDocument()
    const interval = screen.getByRole('combobox', { name: 'Measurement interval' })
    interval.focus()
    expect(interval).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Phasor Angle' })).not.toBeInTheDocument()
  })
})
