import { describe, expect, it } from 'vitest'

import { parseWaveform, rawSample } from './waveformFile'

const magic = [0x4d, 0x4e, 0x43, 0x57, 0x46, 0x31, 0x00, 0x00]

function commonHeader(
  view: DataView,
  version: number,
  headerBytes: number,
  firstSequence: bigint,
  lastSequence: bigint,
) {
  magic.forEach((value, index) => view.setUint8(index, value))
  view.setUint32(8, version, true)
  view.setUint32(12, headerBytes, true)
  view.setBigUint64(16, 7n, true)
  view.setBigUint64(24, firstSequence, true)
  view.setBigUint64(32, lastSequence, true)
  view.setBigUint64(40, firstSequence, true)
  view.setBigUint64(48, 123_000_000n, true)
  view.setUint32(56, 32_000, true)
  view.setUint32(60, 0, true)
}

function legacyV1(): ArrayBuffer {
  const buffer = new ArrayBuffer(128 + 2 * 32)
  const view = new DataView(buffer)
  commonHeader(view, 1, 128, 10n, 11n)
  view.setInt32(128, -123, true)
  return buffer
}

function describedFile(version: 2 | 3, decimation = 1): ArrayBuffer {
  const frameCount = 3
  const channelOffset = 256
  const eventOffset = channelOffset + 32
  const frameOffset = eventOffset
  const buffer = new ArrayBuffer(frameOffset + frameCount * 4)
  const view = new DataView(buffer)
  commonHeader(view, version, 256, 100n,
    100n + BigInt(frameCount - 1) * BigInt(decimation))
  view.setUint32(96, 1, true)
  view.setUint32(100, 4, true)
  view.setUint32(104, 32, true)
  view.setBigUint64(112, BigInt(channelOffset), true)
  view.setBigUint64(120, BigInt(eventOffset), true)
  view.setBigUint64(128, BigInt(frameOffset), true)
  view.setBigUint64(136, BigInt(frameCount), true)
  view.setUint32(152, version === 3 ? decimation : 0, true)

  view.setUint32(channelOffset, 0, true)
  view.setUint32(channelOffset + 4, 1, true)
  view.setUint32(channelOffset + 8, 65_536, true)
  view.setUint32(channelOffset + 12, 1, true)
  view.setInt32(frameOffset, -321, true)
  return buffer
}

describe('MNCWF compatibility contract', () => {
  it('keeps the legacy v1 implicit eight-channel layout', () => {
    const waveform = parseWaveform(legacyV1())

    expect(waveform.version).toBe(1)
    expect(waveform.decimation).toBe(1)
    expect(waveform.effectiveSampleRateHz).toBe(32_000)
    expect(waveform.channels).toHaveLength(8)
    expect(rawSample(waveform, 0, 0)).toBe(-123)
  })

  it('treats the v2 offset-152 reservation as implicit decimation one', () => {
    const waveform = parseWaveform(describedFile(2))

    expect(waveform.version).toBe(2)
    expect(waveform.decimation).toBe(1)
    expect(waveform.frameCount).toBe(3)
    expect(rawSample(waveform, 0, 0)).toBe(-321)
  })

  it('uses the v3 divisor for sequence span and effective rate', () => {
    const waveform = parseWaveform(describedFile(3, 4))

    expect(waveform.version).toBe(3)
    expect(waveform.decimation).toBe(4)
    expect(waveform.firstSequence).toBe(100n)
    expect(waveform.lastSequence).toBe(108n)
    expect(waveform.frameCount).toBe(3)
    expect(waveform.effectiveSampleRateHz).toBe(8_000)
  })

  it('rejects an unsupported v3 decimation divisor', () => {
    expect(() => parseWaveform(describedFile(3, 3))).toThrow(
      'Invalid MNCWF decimation 3',
    )
  })
})
