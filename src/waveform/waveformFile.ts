export type WaveformChannelKind = 'current' | 'voltage' | 'debug'

export interface WaveformChannel {
  sourceChannel: number
  name: string
  unit: string
  kind: WaveformChannelKind
  scaleMicroUnitsQ16: number
  conversionValid: boolean
}

export interface WaveformEvent {
  sequence: bigint
  taiNanoseconds: bigint
  source: number
}

export interface ParsedWaveform {
  version: number
  sessionId: bigint
  firstSequence: bigint
  lastSequence: bigint
  triggerSequence: bigint
  triggerTaiNanoseconds: bigint
  triggerRealtimeNanoseconds: bigint
  sampleRateHz: number
  frameCount: number
  frameBytes: number
  frameDataOffset: number
  channels: WaveformChannel[]
  events: WaveformEvent[]
  data: DataView
}

const MAGIC = [0x4d, 0x4e, 0x43, 0x57, 0x46, 0x31, 0, 0]
const CHANNEL_DESCRIPTOR_BYTES = 32
const EVENT_BYTES = 24

function requireRange(length: number, offset: number, bytes: number, label: string) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes) ||
      offset < 0 || bytes < 0 || offset > length || bytes > length - offset)
    throw new Error(`Invalid ${label} range in waveform file`)
}

function safeNumber(value: bigint, label: string) {
  const result = Number(value)
  if (!Number.isSafeInteger(result))
    throw new Error(`${label} exceeds browser-safe range`)
  return result
}

function fixedString(data: DataView, offset: number, bytes: number) {
  requireRange(data.byteLength, offset, bytes, 'string')
  const octets = new Uint8Array(data.buffer, data.byteOffset + offset, bytes)
  const end = octets.indexOf(0)
  return new TextDecoder().decode(end < 0 ? octets : octets.subarray(0, end))
}

function channelKind(value: number): WaveformChannelKind {
  if (value === 1) return 'current'
  if (value === 2) return 'voltage'
  return 'debug'
}

function legacyChannels(): WaveformChannel[] {
  return Array.from({ length: 8 }, (_, index) => ({
    sourceChannel: index,
    name: `CH${index}`,
    unit: 'count',
    kind: index < 4 ? 'current' : index < 7 ? 'voltage' : 'debug',
    scaleMicroUnitsQ16: 0,
    conversionValid: false,
  }))
}

export function parseWaveform(buffer: ArrayBuffer): ParsedWaveform {
  const data = new DataView(buffer)
  requireRange(data.byteLength, 0, 16, 'header')
  for (let index = 0; index < MAGIC.length; ++index) {
    if (data.getUint8(index) !== MAGIC[index])
      throw new Error('The selected file is not an MNCWF waveform')
  }

  const version = data.getUint32(8, true)
  const headerBytes = data.getUint32(12, true)
  if ((version === 1 && headerBytes !== 128) ||
      (version === 2 && headerBytes !== 256))
    throw new Error(`Unsupported MNCWF header for version ${version}`)
  if (version !== 1 && version !== 2)
    throw new Error(`Unsupported MNCWF version ${version}`)
  requireRange(data.byteLength, 0, headerBytes, 'header')

  const sessionId = data.getBigUint64(16, true)
  const firstSequence = data.getBigUint64(24, true)
  const lastSequence = data.getBigUint64(32, true)
  const triggerSequence = data.getBigUint64(40, true)
  const triggerTaiNanoseconds = data.getBigUint64(48, true)
  const sampleRateHz = data.getUint32(56, true)
  const eventCount = data.getUint32(60, true)

  let channels: WaveformChannel[]
  let frameBytes: number
  let frameDataOffset: number
  let frameCount: number
  let eventTableOffset: number
  let triggerRealtimeNanoseconds = 0n

  if (version === 2) {
    const channelCount = data.getUint32(96, true)
    frameBytes = data.getUint32(100, true)
    const descriptorBytes = data.getUint32(104, true)
    const channelTableOffset = safeNumber(data.getBigUint64(112, true), 'channel table offset')
    eventTableOffset = safeNumber(data.getBigUint64(120, true), 'event table offset')
    frameDataOffset = safeNumber(data.getBigUint64(128, true), 'frame data offset')
    frameCount = safeNumber(data.getBigUint64(136, true), 'frame count')
    triggerRealtimeNanoseconds = data.getBigUint64(144, true)
    if (channelCount === 0 || channelCount > 8 ||
        descriptorBytes !== CHANNEL_DESCRIPTOR_BYTES ||
        frameBytes !== channelCount * 4)
      throw new Error('Invalid MNCWF channel layout')
    requireRange(data.byteLength, channelTableOffset,
      channelCount * descriptorBytes, 'channel table')
    channels = Array.from({ length: channelCount }, (_, index) => {
      const offset = channelTableOffset + index * descriptorBytes
      const flags = data.getUint32(offset + 12, true)
      return {
        sourceChannel: data.getUint32(offset, true),
        kind: channelKind(data.getUint32(offset + 4, true)),
        scaleMicroUnitsQ16: data.getUint32(offset + 8, true),
        conversionValid: (flags & 1) !== 0,
        name: fixedString(data, offset + 16, 8) || `CH${index}`,
        unit: fixedString(data, offset + 24, 8) || 'count',
      }
    })
  } else {
    channels = legacyChannels()
    frameBytes = 32
    eventTableOffset = 128
    frameDataOffset = eventTableOffset + eventCount * EVENT_BYTES
    if (lastSequence < firstSequence)
      throw new Error('Invalid legacy MNCWF sequence range')
    frameCount = safeNumber(lastSequence - firstSequence + 1n, 'frame count')
  }

  requireRange(data.byteLength, eventTableOffset, eventCount * EVENT_BYTES, 'event table')
  requireRange(data.byteLength, frameDataOffset, frameCount * frameBytes, 'sample data')
  if (lastSequence < firstSequence ||
      BigInt(frameCount) !== lastSequence - firstSequence + 1n)
    throw new Error('MNCWF frame count does not match its sequence range')

  const events = Array.from({ length: eventCount }, (_, index) => {
    const offset = eventTableOffset + index * EVENT_BYTES
    return {
      sequence: data.getBigUint64(offset, true),
      taiNanoseconds: data.getBigUint64(offset + 8, true),
      source: data.getUint32(offset + 16, true),
    }
  })

  return {
    version,
    sessionId,
    firstSequence,
    lastSequence,
    triggerSequence,
    triggerTaiNanoseconds,
    triggerRealtimeNanoseconds,
    sampleRateHz,
    frameCount,
    frameBytes,
    frameDataOffset,
    channels,
    events,
    data,
  }
}

export function rawSample(waveform: ParsedWaveform, frame: number, channel: number) {
  if (frame < 0 || frame >= waveform.frameCount ||
      channel < 0 || channel >= waveform.channels.length)
    throw new RangeError('Waveform sample index is outside the capture')
  return waveform.data.getInt32(
    waveform.frameDataOffset + frame * waveform.frameBytes + channel * 4,
    true,
  )
}

export function convertedSample(raw: number, channel: WaveformChannel) {
  if (!channel.conversionValid) return undefined
  // Divide the coefficient first so the intermediate stays below
  // JavaScript's exact-integer limit for every signed 24-bit ADC value.
  return raw * (channel.scaleMicroUnitsQ16 / 65536) / 1_000_000
}

export interface WaveformEnvelope {
  minimum: number
  maximum: number
  points: string
}

export function waveformEnvelope(
  waveform: ParsedWaveform,
  channelIndex: number,
  converted: boolean,
  width = 1200,
  height = 88,
  firstFrame = 0,
  lastFrame = waveform.frameCount,
): WaveformEnvelope {
  const channel = waveform.channels[channelIndex]
  const windowFirst = Math.max(0, Math.min(
    waveform.frameCount - 1, Math.floor(firstFrame),
  ))
  const windowLast = Math.max(windowFirst + 1, Math.min(
    waveform.frameCount, Math.ceil(lastFrame),
  ))
  const windowFrames = windowLast - windowFirst
  const bucketCount = Math.max(1, Math.min(width, windowFrames))
  const minima = new Array<number>(bucketCount)
  const maxima = new Array<number>(bucketCount)
  let captureMinimum = Number.POSITIVE_INFINITY
  let captureMaximum = Number.NEGATIVE_INFINITY

  for (let bucket = 0; bucket < bucketCount; ++bucket) {
    /*
     * Proportional boundaries guarantee that every bucket contains at least
     * one frame when bucketCount <= frameCount. Using ceil(samples/buckets)
     * can leave empty tail buckets, producing Infinity SVG coordinates and
     * making the browser discard the complete waveform polygon.
     */
    const first = windowFirst +
      Math.floor(bucket * windowFrames / bucketCount)
    const last = windowFirst +
      Math.floor((bucket + 1) * windowFrames / bucketCount)
    let minimum = Number.POSITIVE_INFINITY
    let maximum = Number.NEGATIVE_INFINITY
    for (let frame = first; frame < last; ++frame) {
      const raw = rawSample(waveform, frame, channelIndex)
      const value = converted ? convertedSample(raw, channel) ?? raw : raw
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
    minima[bucket] = minimum
    maxima[bucket] = maximum
    captureMinimum = Math.min(captureMinimum, minimum)
    captureMaximum = Math.max(captureMaximum, maximum)
  }

  const span = Math.max(Number.EPSILON, captureMaximum - captureMinimum)
  const point = (bucket: number, value: number) => {
    const x = bucketCount === 1 ? 0 : bucket / (bucketCount - 1) * width
    const y = height - (value - captureMinimum) / span * height
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }
  const upper = maxima.map((value, bucket) => point(bucket, value))
  const lower = minima.map((value, bucket) => point(bucket, value)).reverse()
  return {
    minimum: captureMinimum,
    maximum: captureMaximum,
    points: [...upper, ...lower].join(' '),
  }
}
