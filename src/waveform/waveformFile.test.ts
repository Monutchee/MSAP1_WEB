import { describe, expect, it } from 'vitest'

import {
  convertedSample, parseWaveform, parseWaveformAsync, rawSample, waveformDurationSeconds,
  waveformFrameForSequence,
} from './waveformFile'

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

function alignEight(value: number) {
  return Math.ceil(value / 8) * 8
}

function crc32c(bytes: Uint8Array) {
  let crc = 0xffff_ffff
  for (const octet of bytes) {
    crc ^= octet
    for (let bit = 0; bit < 8; ++bit)
      crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f6_3b78 : 0)
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

interface V4SectionFixture {
  type: number
  version: number
  itemBytes: number
  itemCount: number
  logicalBytes: number
  payload: Uint8Array
}

function v4Section(
  type: number,
  itemBytes: number,
  records: Uint8Array,
  blob = new Uint8Array(),
): V4SectionFixture {
  const itemCount = itemBytes === 0 ? 0 : records.byteLength / itemBytes
  const recordsEnd = 48 + records.byteLength
  const blobOffset = blob.byteLength > 0 ? alignEight(recordsEnd) : 0
  const payload = new Uint8Array(blob.byteLength > 0
    ? blobOffset + blob.byteLength : recordsEnd)
  const view = new DataView(payload.buffer)
  view.setUint32(0, type, true)
  view.setUint16(4, 1, true)
  view.setUint16(6, 48, true)
  view.setUint32(12, itemBytes, true)
  view.setBigUint64(16, BigInt(itemCount), true)
  if (blob.byteLength > 0) {
    view.setBigUint64(24, BigInt(blobOffset), true)
    view.setBigUint64(32, BigInt(blob.byteLength), true)
  }
  payload.set(records, 48)
  if (blob.byteLength > 0) payload.set(blob, blobOffset)
  return {
    type, version: 1, itemBytes, itemCount,
    logicalBytes: payload.byteLength, payload,
  }
}

function v5SampleSection(frameCount: number, mixed = false): V4SectionFixture {
  const compressed = Uint8Array.from([
    0x28, 0xb5, 0x2f, 0xfd, 0x64, 0x00, 0x03, 0x4d,
    0x00, 0x00, 0x10, 0x00, 0x00, 0x01, 0x00, 0xfb,
    0x2b, 0x80, 0x05, 0xcd, 0xac, 0x85, 0xf0,
  ])
  const compressedFrames = 256
  const frameBytes = 4
  if (frameCount !== compressedFrames + (mixed ? 1 : 0))
    throw new Error('Invalid v5 test fixture frame count')
  const compressedLogical = new Uint8Array(compressedFrames * frameBytes)
  const raw = Uint8Array.from([0x78, 0x56, 0x34, 0x12])
  const tableBytes = mixed ? 112 : 56
  const payloadOffset = alignEight(48 + tableBytes)
  const rawOffset = alignEight(payloadOffset + compressed.byteLength)
  const payloadEnd = mixed ? rawOffset + raw.byteLength
    : payloadOffset + compressed.byteLength
  const payload = new Uint8Array(alignEight(payloadEnd))
  const view = new DataView(payload.buffer)
  view.setUint32(0, 7, true)
  view.setUint16(4, 2, true)
  view.setUint16(6, 48, true)
  view.setUint32(12, frameBytes, true)
  view.setBigUint64(16, BigInt(frameCount), true)
  view.setBigUint64(24, 48n, true)
  view.setBigUint64(32, BigInt(tableBytes), true)
  view.setBigUint64(48, 0n, true)
  view.setBigUint64(56, BigInt(compressedFrames), true)
  view.setBigUint64(64, BigInt(payloadOffset), true)
  view.setBigUint64(72, BigInt(compressed.byteLength), true)
  view.setBigUint64(80, BigInt(compressedLogical.byteLength), true)
  view.setUint16(88, 1, true)
  view.setUint16(90, 1, true)
  view.setUint32(92, crc32c(compressedLogical), true)
  if (mixed) {
    const rawEntry = 48 + 56
    view.setBigUint64(rawEntry, BigInt(compressedFrames), true)
    view.setBigUint64(rawEntry + 8, 1n, true)
    view.setBigUint64(rawEntry + 16, BigInt(rawOffset), true)
    view.setBigUint64(rawEntry + 24, BigInt(raw.byteLength), true)
    view.setBigUint64(rawEntry + 32, BigInt(raw.byteLength), true)
    view.setUint32(rawEntry + 44, crc32c(raw), true)
    payload.set(raw, rawOffset)
  }
  payload.set(compressed, payloadOffset)
  return {
    type: 7,
    version: 2,
    itemBytes: frameBytes,
    itemCount: frameCount,
    logicalBytes: frameCount * frameBytes,
    payload,
  }
}

function setReference(view: DataView, offset: number, first: number, length: number) {
  view.setUint32(offset, first, true)
  view.setUint32(offset + 4, length, true)
}

function v4File(formatVersion: 4 | 5 = 4, mixedV5 = false): ArrayBuffer {
  const frameCount = formatVersion === 5 ? 256 + (mixedV5 ? 1 : 0) : 3
  const captureRecord = new Uint8Array(256)
  captureRecord.fill(1, 0, 96)
  const captureView = new DataView(captureRecord.buffer)
  captureView.setBigUint64(96, 1_700_000_000_000_000_000n, true)
  captureView.setBigUint64(104, 1_700_000_000_000_000_000n, true)
  captureView.setBigInt64(112, 120n, true)
  captureView.setBigUint64(120, 1n, true)
  captureView.setBigUint64(128, 60n, true)
  captureView.setBigUint64(136, 1n, true)
  captureView.setUint32(144, 1, true)
  const captureStrings = new TextEncoder().encode('MSAP1fwbuildprofilesettings')
  setReference(captureView, 184, 0, 5)
  setReference(captureView, 200, 5, 2)
  setReference(captureView, 208, 7, 5)
  setReference(captureView, 216, 12, 7)
  setReference(captureView, 224, 19, 8)

  const timeRecord = new Uint8Array(128)
  const timeView = new DataView(timeRecord.buffer)
  timeView.setBigUint64(8, BigInt(frameCount), true)
  timeView.setBigUint64(16, 100n, true)
  timeView.setBigUint64(24, 4n, true)
  timeView.setBigUint64(32, 128_000n, true)
  timeView.setBigUint64(40, 1n, true)
  timeView.setBigUint64(48, 32_000n, true)
  timeView.setBigUint64(56, 1n, true)
  timeView.setBigUint64(64, 100n, true)
  timeView.setBigUint64(72, 10_000n, true)
  timeView.setBigUint64(80, 1_700_000_000_000_000_000n, true)
  timeView.setBigUint64(88, 1_700_000_000_000_000_000n, true)
  timeView.setUint32(104, 4, true)
  timeView.setUint16(108, 1, true)
  timeView.setUint16(110, 1, true)
  timeView.setUint16(112, 3, true)
  timeView.setUint16(114, 1, true)
  timeView.setBigUint64(120, BigInt(frameCount * 4), true)

  const channelRecord = new Uint8Array(208)
  channelRecord.fill(2, 0, 16)
  const channelView = new DataView(channelRecord.buffer)
  channelView.setUint32(16, 6, true)
  channelView.setUint32(20, 3, true)
  channelView.setUint16(24, 1, true)
  channelView.setUint16(26, 2, true)
  channelView.setUint16(28, 2, true)
  channelView.setUint16(30, 1, true)
  channelView.setUint16(32, 32, true)
  channelView.setUint16(34, 24, true)
  channelView.setBigInt64(40, 1n, true)
  channelView.setBigUint64(48, 100n, true)
  channelView.setBigUint64(64, 1n, true)
  setReference(channelView, 168, 0, 2)
  setReference(channelView, 176, 2, 1)
  const channelStrings = new TextEncoder().encode('VaV')

  const eventRecord = new Uint8Array(256)
  eventRecord.fill(3, 0, 16)
  const eventView = new DataView(eventRecord.buffer)
  eventView.setUint16(16, 2, true)
  eventView.setUint16(18, 0x101, true)
  eventView.setUint16(20, 5, true)
  eventView.setUint16(22, 3, true)
  eventView.setUint32(24, 0x7f, true)
  eventView.setUint32(28, 16, true)
  eventView.setUint16(32, 3, true)
  eventView.setUint16(36, 2, true)
  for (const offset of [48, 56, 64, 72])
    eventView.setBigUint64(offset, 104n, true)
  for (const offset of [80, 88, 96, 104, 112, 120, 128, 136])
    eventView.setBigUint64(offset, 1_700_000_000_000_031_250n, true)
  eventView.setBigUint64(208, 1n, true)
  const eventStrings = new TextEncoder().encode(
    'MSAP1 capture triggermanual Web capture{"trigger":"manual_web"}')
  setReference(eventView, 224, 0, 21)
  setReference(eventView, 232, 21, 18)
  setReference(eventView, 240, 39, 24)

  const sampleRecords = new Uint8Array(frameCount * 4)
  const sampleView = new DataView(sampleRecords.buffer)
  sampleView.setInt32(0, -100, true)
  sampleView.setInt32(4, 200, true)
  sampleView.setInt32(8, 300, true)

  const sections = [
    v4Section(1, 256, captureRecord, captureStrings),
    v4Section(2, 128, timeRecord),
    v4Section(3, 208, channelRecord, channelStrings),
    v4Section(4, 256, eventRecord, eventStrings),
    v4Section(5, 64, new Uint8Array()),
    v4Section(6, 64, new Uint8Array()),
    formatVersion === 5 ? v5SampleSection(frameCount, mixedV5) :
      v4Section(7, 4, sampleRecords),
  ]
  const directoryBytes = sections.length * 56
  let next = alignEight(64 + directoryBytes)
  const offsets = sections.map((section) => {
    const offset = next
    next = alignEight(next + section.payload.byteLength)
    return offset
  })
  const buffer = new ArrayBuffer(next)
  const octets = new Uint8Array(buffer)
  const view = new DataView(buffer)
  magic.forEach((value, index) => view.setUint8(index, value))
  view.setUint32(8, formatVersion, true)
  view.setUint32(12, 64, true)
  view.setUint32(16, 56, true)
  view.setUint32(20, sections.length, true)
  view.setBigUint64(24, 64n, true)
  view.setBigUint64(32, BigInt(directoryBytes), true)
  view.setBigUint64(40, BigInt(buffer.byteLength), true)
  sections.forEach((section, index) => {
    const directory = 64 + index * 56
    view.setUint32(directory, section.type, true)
    view.setUint16(directory + 4, section.version, true)
    view.setUint16(directory + 6, 1, true)
    view.setBigUint64(directory + 8, BigInt(offsets[index]), true)
    view.setBigUint64(directory + 16, BigInt(section.payload.byteLength), true)
    view.setBigUint64(directory + 24, BigInt(section.logicalBytes), true)
    view.setBigUint64(directory + 32, BigInt(section.itemCount), true)
    view.setUint32(directory + 40, section.itemBytes, true)
    view.setUint32(directory + 44, crc32c(section.payload), true)
    octets.set(section.payload, offsets[index])
  })
  view.setUint32(52, crc32c(octets.subarray(64, 64 + directoryBytes)), true)
  view.setUint32(56, crc32c(octets.subarray(0, 64)), true)
  return buffer
}

function refreshV5Checksums(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  const octets = new Uint8Array(buffer)
  const sampleDirectory = 64 + 6 * 56
  const sampleOffset = Number(view.getBigUint64(sampleDirectory + 8, true))
  const sampleBytes = Number(view.getBigUint64(sampleDirectory + 16, true))
  view.setUint32(sampleDirectory + 44,
    crc32c(octets.subarray(sampleOffset, sampleOffset + sampleBytes)), true)
  view.setUint32(52, crc32c(octets.subarray(64, 64 + 7 * 56)), true)
  view.setUint32(56, 0, true)
  view.setUint32(56, crc32c(octets.subarray(0, 64)), true)
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

  it('opens production MNCWF v4 section-directory captures', () => {
    const waveform = parseWaveform(v4File())

    expect(waveform.version).toBe(4)
    expect(waveform.sampleRateHz).toBe(128_000)
    expect(waveform.decimation).toBe(4)
    expect(waveform.effectiveSampleRateHz).toBe(32_000)
    expect(waveform.firstSequence).toBe(100n)
    expect(waveform.lastSequence).toBe(111n)
    expect(waveform.triggerSequence).toBe(104n)
    expect(waveformFrameForSequence(waveform, 104n)).toBe(1)
    expect(waveformDurationSeconds(waveform)).toBeCloseTo(3 / 32_000)
    expect(waveform.channels[0]).toMatchObject({
      sourceChannel: 6, name: 'Va', unit: 'V', kind: 'voltage',
      conversionValid: true,
    })
    expect(rawSample(waveform, 0, 0)).toBe(-100)
    expect(convertedSample(-100, waveform.channels[0])).toBe(-1)
  })

  it('rejects a v4 sample payload whose section CRC no longer matches', () => {
    const buffer = v4File()
    const view = new DataView(buffer)
    const sampleDirectory = 64 + 6 * 56
    const sampleOffset = Number(view.getBigUint64(sampleDirectory + 8, true))
    new Uint8Array(buffer)[sampleOffset + 48] ^= 1

    expect(() => parseWaveform(buffer)).toThrow('section CRC32C mismatch')
  })

  it('opens compressed MNCWF v5 chunks through the asynchronous worker parser', async () => {
    const waveform = await parseWaveformAsync(v4File(5))

    expect(waveform.version).toBe(5)
    expect(waveform.frameCount).toBe(256)
    expect(waveform.data.byteLength).toBe(1024)
    expect(rawSample(waveform, 0, 0)).toBe(0)
    expect(rawSample(waveform, 255, 0)).toBe(0)
    expect(() => parseWaveform(v4File(5))).toThrow('waveform worker')
  })

  it('decodes an APU-compatible mixed Zstd and raw v5 chunk vector', async () => {
    const waveform = await parseWaveformAsync(v4File(5, true))

    expect(waveform.frameCount).toBe(257)
    expect(rawSample(waveform, 255, 0)).toBe(0)
    expect(rawSample(waveform, 256, 0)).toBe(0x1234_5678)
  })

  it('rejects a v5 chunk whose logical CRC does not match decompressed samples', async () => {
    const buffer = v4File(5)
    const view = new DataView(buffer)
    const sampleDirectory = 64 + 6 * 56
    const sampleOffset = Number(view.getBigUint64(sampleDirectory + 8, true))
    view.setUint32(sampleOffset + 48 + 44,
      view.getUint32(sampleOffset + 48 + 44, true) ^ 1, true)
    refreshV5Checksums(buffer)

    await expect(parseWaveformAsync(buffer)).rejects.toThrow(
      'logical CRC32C mismatch',
    )
  })

  it('rejects a v5 Zstd frame that omits its declared checksum', async () => {
    const buffer = v4File(5)
    const view = new DataView(buffer)
    const sampleDirectory = 64 + 6 * 56
    const sampleOffset = Number(view.getBigUint64(sampleDirectory + 8, true))
    const chunkEntry = sampleOffset + 48
    const storedOffset = Number(view.getBigUint64(chunkEntry + 16, true))
    const descriptor = sampleOffset + storedOffset + 4
    new Uint8Array(buffer)[descriptor] &= ~0x04
    refreshV5Checksums(buffer)

    await expect(parseWaveformAsync(buffer)).rejects.toThrow(
      'Unsupported Zstd frame options',
    )
  })
})
