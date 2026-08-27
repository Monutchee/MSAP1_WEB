import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api, ApiError, HarmonicChannel, HarmonicOrder, HarmonicSpectrum,
  MeterReadings,
} from '../api'
import './reading.css'

type HarmonicGroup = 'voltage' | 'current'

interface ChannelColumn {
  channel: number
  label: string
}

const CHANNEL_GROUPS: Record<HarmonicGroup, ChannelColumn[]> = {
  voltage: [
    { channel: 6, label: 'Va' },
    { channel: 5, label: 'Vb' },
    { channel: 4, label: 'Vc' },
  ],
  current: [
    { channel: 0, label: 'Ia' },
    { channel: 1, label: 'Ib' },
    { channel: 2, label: 'Ic' },
    { channel: 3, label: 'In' },
  ],
}

const ALL_HARMONIC_ORDERS = Array.from({ length: 127 }, (_, index) => index + 1)

function formatCount(value: number | undefined) {
  return value === undefined ? '—' : new Intl.NumberFormat('en-US').format(value)
}

function formatMagnitude(value: number) {
  return value.toLocaleString('en-US', { maximumSignificantDigits: 7 })
}

function HarmonicStatus({ ok, pending = false, children }: {
  ok: boolean
  pending?: boolean
  children: string
}) {
  const state = pending ? 'neutral' : ok ? 'ok' : 'bad'
  return <span className={`status-pill ${state}`}><i />{children}</span>
}

function HarmonicCell({ point, channel, qualified }: {
  point: HarmonicOrder | undefined
  channel: HarmonicChannel | undefined
  qualified: boolean
}) {
  if (!qualified) {
    return <td className="harmonic-value unavailable"><strong>—</strong>
      <small>Not qualified</small></td>
  }

  if (!point?.magnitude_valid) {
    return <td className="harmonic-value unavailable"><strong>—</strong>
      <small>Unavailable</small></td>
  }

  return <td className="harmonic-value">
    <strong>{formatMagnitude(point.magnitude)} <span>{channel?.unit ?? ''}</span></strong>
    <small>{point.angle_valid ? `${point.angle_degrees.toFixed(3)}°` : 'Angle unavailable'}</small>
  </td>
}

/**
 * Viewer-facing metrology results. Harmonic families are atomic: a previous
 * family is never mixed with a partial replacement while the API assembles
 * its seven channels and six chunks per channel.
 */
export function ReadingPage({ readings, onUnauthorized }: {
  readings: MeterReadings | undefined
  onUnauthorized: () => void
}) {
  const [group, setGroup] = useState<HarmonicGroup>('voltage')
  const [spectrum, setSpectrum] = useState<HarmonicSpectrum>()
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setSpectrum(await api.meterHarmonics())
      setError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onUnauthorized()
        return
      }
      setError(reason instanceof Error ? reason.message : 'Unable to read harmonics')
    }
  }, [onUnauthorized])

  useEffect(() => {
    let active = true
    let pending = false
    const refresh = async () => {
      if (!active || pending) return
      pending = true
      await load()
      pending = false
    }
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [load])

  const channels = CHANNEL_GROUPS[group]
  const channelByIndex = useMemo(() => new Map(
    spectrum?.channels.map((channel) => [channel.channel, channel]) ?? [],
  ), [spectrum])
  const ordersByChannel = useMemo(() => new Map(
    spectrum?.channels.map((channel) => [
      channel.channel,
      new Map(channel.orders.map((order) => [order.order, order])),
    ]) ?? [],
  ), [spectrum])

  return <section className="reading-page">
    <header className="reading-heading">
      <p className="eyebrow">Readings</p>
      <h1>Meter readings</h1>
      <p>Inspect processed measurement products from the programmable-logic metrology pipeline.</p>
    </header>

    <nav className="reading-subtabs" aria-label="Reading sections">
      <button className="active" type="button" aria-current="page">Harmonics</button>
    </nav>

    <section className="reading-section" aria-labelledby="harmonic-spectrum-title">
      <div className="reading-section-heading">
        <div>
          <p className="eyebrow">Metrology M16</p>
          <h2 id="harmonic-spectrum-title">Harmonic subgroup spectrum</h2>
          <p>Orders 1–127 from one atomic 10/12-cycle family across all seven channels.</p>
        </div>
        <div className="harmonic-controls">
          <label htmlFor="harmonic-group">Measurement</label>
          <select id="harmonic-group" value={group}
            onChange={(event) => setGroup(event.target.value as HarmonicGroup)}>
            <option value="voltage">Voltage</option>
            <option value="current">Current</option>
          </select>
          <span>{spectrum?.available
            ? `Family ${formatCount(spectrum.sequence)}`
            : 'Waiting for a complete family'}</span>
        </div>
      </div>

      {error && <div className="error-banner"><strong>Harmonics unavailable</strong>
        <span>{error}</span></div>}

      <div className="harmonic-summary" aria-label="Harmonic pipeline status">
        <HarmonicStatus ok={spectrum?.grid_locked ?? false} pending={!spectrum}>Grid lock</HarmonicStatus>
        <HarmonicStatus ok={spectrum?.conditioner_valid ?? false} pending={!spectrum}>Conditioner</HarmonicStatus>
        <HarmonicStatus ok={spectrum?.fft_valid ?? false} pending={!spectrum}>FFT</HarmonicStatus>
        <span>Chunks {formatCount(spectrum?.records)}</span>
        <span>Families {formatCount(spectrum?.families)}</span>
        <span>Incomplete {formatCount(spectrum?.incomplete_families)}</span>
        {spectrum?.available && <>
          <span>{(spectrum.measured_frequency_millihz / 1000).toFixed(3)} Hz</span>
          <span>{spectrum.cycle_count} cycles / {formatCount(spectrum.sample_count)} samples</span>
          <span>Qualified through order {spectrum.qualified_max_order}</span>
        </>}
      </div>

      {!spectrum?.available
        ? <div className="harmonic-empty">
          <strong>No complete spectrum yet</strong>
          <span>The adaptive L/25 conditioner supports every selectable rate from 1 to 128 kSPS.
            {readings && <> The current capture is {formatCount(readings.sample_rate_hz)} samples/s with
              {' '}{formatCount(readings.block_sample_count)}-frame basic blocks.</>}
            {' '}The previous spectrum remains hidden until grid lock is valid and all 42 records for one
            family agree.</span>
        </div>
        : <div className="harmonic-table-frame">
          <table className="harmonic-matrix">
            <caption>{group === 'voltage' ? 'Voltage' : 'Current'} harmonic orders 1 through 127</caption>
            <thead><tr>
              <th scope="col">Order</th>
              {channels.map((column) => <th scope="col" key={column.channel}>
                <strong>{column.label}</strong><small>Magnitude · angle</small>
              </th>)}
            </tr></thead>
            <tbody>
              {ALL_HARMONIC_ORDERS.map((order) => <tr key={order}>
                <th scope="row">{order}</th>
                {channels.map((column) => <HarmonicCell key={column.channel}
                  channel={channelByIndex.get(column.channel)}
                  point={ordersByChannel.get(column.channel)?.get(order)}
                  qualified={order <= spectrum.qualified_max_order} />)}
              </tr>)}
            </tbody>
          </table>
        </div>}

      <p className="harmonic-note">Magnitudes are three-bin IEC-style subgroups. Angles are relative to
        the Va fundamental: angle(Xh) − h·angle(Va1), wrapped to 0–360°. Raw FFT bins remain diagnostic-only.</p>
    </section>
  </section>
}
