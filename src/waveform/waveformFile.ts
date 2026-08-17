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
  /**
   * Capture-file decimation divisor (v3): each stored frame is the mean of
   * this many acquisition frames, and sequence numbers stay in the
   * acquisition domain. 1 for v1/v2 files.
   */
  decimation: number
  /** Stored-frame rate: sampleRateHz / decimation. */
  effectiveSampleRateHz: number
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
      (version >= 2 && headerBytes !== 256))
    throw new Error(`Unsupported MNCWF header for version ${version}`)
  if (version !== 1 && version !== 2 && version !== 3)
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
  let decimation = 1

  if (version >= 2) {
    const channelCount = data.getUint32(96, true)
    frameBytes = data.getUint32(100, true)
    const descriptorBytes = data.getUint32(104, true)
    const channelTableOffset = safeNumber(data.getBigUint64(112, true), 'channel table offset')
    eventTableOffset = safeNumber(data.getBigUint64(120, true), 'event table offset')
    frameDataOffset = safeNumber(data.getBigUint64(128, true), 'frame data offset')
    frameCount = safeNumber(data.getBigUint64(136, true), 'frame count')
    triggerRealtimeNanoseconds = data.getBigUint64(144, true)
    /* v2 wrote zeros where v3 keeps the decimation divisor. */
    if (version >= 3) {
      decimation = data.getUint32(152, true)
      if (![1, 2, 4, 8, 16, 32].includes(decimation))
        throw new Error(`Invalid MNCWF decimation ${decimation}`)
    }
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
  /*
   * Sequences stay in the acquisition frame domain, so a decimated file
   * covers (frameCount - 1) * decimation + 1 acquisition frames exactly.
   */
  if (lastSequence < firstSequence ||
      (lastSequence - firstSequence) % BigInt(decimation) !== 0n ||
      BigInt(frameCount - 1) !==
        (lastSequence - firstSequence) / BigInt(decimation))
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
    decimation,
    effectiveSampleRateHz: sampleRateHz / decimation,
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
  scaleMinimum: number
  scaleMaximum: number
  points: string
}

export interface WaveformRange {
  minimum: number
  maximum: number
}

function sampleValue(
  waveform: ParsedWaveform,
  frame: number,
  channelIndex: number,
  converted: boolean,
) {
  const raw = rawSample(waveform, frame, channelIndex)
  return converted
    ? convertedSample(raw, waveform.channels[channelIndex]) ?? raw
    : raw
}

export function waveformRange(
  waveform: ParsedWaveform,
  channelIndex: number,
  converted: boolean,
  firstFrame = 0,
  lastFrame = waveform.frameCount,
): WaveformRange {
  const windowFirst = Math.max(0, Math.min(
    waveform.frameCount - 1, Math.floor(firstFrame),
  ))
  const windowLast = Math.max(windowFirst + 1, Math.min(
    waveform.frameCount, Math.ceil(lastFrame),
  ))
  let minimum = Number.POSITIVE_INFINITY
  let maximum = Number.NEGATIVE_INFINITY
  for (let frame = windowFirst; frame < windowLast; ++frame) {
    const value = sampleValue(waveform, frame, channelIndex, converted)
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  }
  return { minimum, maximum }
}

function expandedRange(range: WaveformRange): WaveformRange {
  const magnitude = Math.max(Math.abs(range.minimum), Math.abs(range.maximum), 1)
  const span = Math.max(range.maximum - range.minimum, magnitude * 1e-6)
  const padding = span * .06
  return {
    minimum: range.minimum - padding,
    maximum: range.maximum + padding,
  }
}

/**
 * Hierarchical min/max reduction of the raw samples, built once per file.
 *
 * A 20 s capture at 128 kSPS holds ~2.6M frames x 7 channels; scanning that
 * per pan/zoom event is what made the viewer lag. Level 0 folds every
 * `baseGranularity` frames into a min/max pair per channel; each further
 * level folds two entries into one. Any envelope query then reads the
 * coarsest level that still gives >= 2 entries per pixel bucket, so its cost
 * is proportional to the plot width, never to the visible frame count.
 *
 * The pyramid stores raw ADC counts only: unit conversion is a non-negative
 * linear scale (scaleMicroUnitsQ16 is unsigned), which preserves min/max
 * ordering, so converted views multiply at query time instead of needing a
 * second pyramid.
 */
export interface WaveformPyramidLevel {
  /** Frames covered by one entry. */
  granularity: number
  /** Channel-major: index = channel * entryCount + entry. */
  minima: Int32Array
  maxima: Int32Array
  entryCount: number
}

export interface WaveformPyramid {
  /** Frame-major interleaved raw samples: index = frame * channels + channel. */
  samples: Int32Array
  levels: WaveformPyramidLevel[]
}

const INT32_MINIMUM = -2147483648
const INT32_MAXIMUM = 2147483647

/**
 * The frame data as one typed-array view. Every MNCWF layout keeps the frame
 * data 4-byte aligned (headers, channel descriptors, and 24-byte events are
 * all multiples of 4), so the copy fallback exists only for defence.
 */
function frameSamples(waveform: ParsedWaveform): Int32Array {
  const length = waveform.frameCount * waveform.channels.length
  const byteOffset = waveform.data.byteOffset + waveform.frameDataOffset
  if (byteOffset % 4 === 0)
    return new Int32Array(waveform.data.buffer, byteOffset, length)
  const copy = new Int32Array(length)
  for (let index = 0; index < length; ++index)
    copy[index] = waveform.data.getInt32(
      waveform.frameDataOffset + index * 4, true)
  return copy
}

export function buildWaveformPyramid(
  waveform: ParsedWaveform,
  baseGranularity = 32,
): WaveformPyramid {
  const channelCount = waveform.channels.length
  const frames = waveform.frameCount
  const samples = frameSamples(waveform)
  const levels: WaveformPyramidLevel[] = []

  let entryCount = Math.max(1, Math.ceil(frames / baseGranularity))
  let minima = new Int32Array(channelCount * entryCount).fill(INT32_MAXIMUM)
  let maxima = new Int32Array(channelCount * entryCount).fill(INT32_MINIMUM)
  for (let frame = 0, entry = 0, used = 0; frame < frames; ++frame) {
    const row = frame * channelCount
    for (let channel = 0; channel < channelCount; ++channel) {
      const value = samples[row + channel]
      const index = channel * entryCount + entry
      if (value < minima[index]) minima[index] = value
      if (value > maxima[index]) maxima[index] = value
    }
    if (++used === baseGranularity) {
      used = 0
      ++entry
    }
  }
  levels.push({ granularity: baseGranularity, minima, maxima, entryCount })

  let granularity = baseGranularity
  while (entryCount > 2) {
    const parentCount = Math.ceil(entryCount / 2)
    const parentMinima =
      new Int32Array(channelCount * parentCount).fill(INT32_MAXIMUM)
    const parentMaxima =
      new Int32Array(channelCount * parentCount).fill(INT32_MINIMUM)
    for (let channel = 0; channel < channelCount; ++channel) {
      const childBase = channel * entryCount
      const parentBase = channel * parentCount
      for (let entry = 0; entry < entryCount; ++entry) {
        const parent = parentBase + (entry >> 1)
        const child = childBase + entry
        if (minima[child] < parentMinima[parent])
          parentMinima[parent] = minima[child]
        if (maxima[child] > parentMaxima[parent])
          parentMaxima[parent] = maxima[child]
      }
    }
    granularity *= 2
    entryCount = parentCount
    minima = parentMinima
    maxima = parentMaxima
    levels.push({ granularity, minima, maxima, entryCount })
  }
  return { samples, levels }
}

/** Non-negative factor mapping raw counts to display units (1 = raw). */
function displayFactor(
  waveform: ParsedWaveform,
  channelIndex: number,
  converted: boolean,
) {
  const channel = waveform.channels[channelIndex]
  return converted && channel.conversionValid
    ? channel.scaleMicroUnitsQ16 / 65536 / 1_000_000
    : 1
}

/** Whole-capture range from the pyramid's coarsest level — O(entries). */
export function pyramidRange(
  waveform: ParsedWaveform,
  pyramid: WaveformPyramid,
  channelIndex: number,
  converted: boolean,
): WaveformRange {
  const top = pyramid.levels[pyramid.levels.length - 1]
  let minimum = INT32_MAXIMUM
  let maximum = INT32_MINIMUM
  const base = channelIndex * top.entryCount
  for (let entry = 0; entry < top.entryCount; ++entry) {
    if (top.minima[base + entry] < minimum) minimum = top.minima[base + entry]
    if (top.maxima[base + entry] > maximum) maximum = top.maxima[base + entry]
  }
  const factor = displayFactor(waveform, channelIndex, converted)
  return { minimum: minimum * factor, maximum: maximum * factor }
}

export function pyramidEnvelope(
  waveform: ParsedWaveform,
  pyramid: WaveformPyramid,
  channelIndex: number,
  converted: boolean,
  width = 1200,
  height = 88,
  firstFrame = 0,
  lastFrame = waveform.frameCount,
  verticalRange?: WaveformRange,
): WaveformEnvelope {
  const channelCount = waveform.channels.length
  const windowFirst = Math.max(0, Math.min(
    waveform.frameCount - 1, Math.floor(firstFrame),
  ))
  const windowLast = Math.max(windowFirst + 1, Math.min(
    waveform.frameCount, Math.ceil(lastFrame),
  ))
  const windowFrames = windowLast - windowFirst
  const bucketCount = Math.max(1, Math.min(width, windowFrames))
  const bucketSpan = windowFrames / bucketCount
  const factor = displayFactor(waveform, channelIndex, converted)

  /*
   * Pick the coarsest level that still yields at least two entries per
   * bucket; below two the bucket boundary quantization would visibly widen
   * the envelope. When even the base level is too coarse (deep zoom, few
   * frames per pixel), scan the raw samples directly — the window is at
   * most 2 * baseGranularity * width frames, which is small.
   */
  let level: WaveformPyramidLevel | undefined
  for (const candidate of pyramid.levels) {
    if (candidate.granularity * 2 > bucketSpan) break
    level = candidate
  }

  const minima = new Array<number>(bucketCount)
  const maxima = new Array<number>(bucketCount)
  let captureMinimum = Number.POSITIVE_INFINITY
  let captureMaximum = Number.NEGATIVE_INFINITY
  for (let bucket = 0; bucket < bucketCount; ++bucket) {
    const first = windowFirst +
      Math.floor(bucket * windowFrames / bucketCount)
    const last = windowFirst +
      Math.floor((bucket + 1) * windowFrames / bucketCount)
    let minimum = INT32_MAXIMUM
    let maximum = INT32_MINIMUM
    if (level) {
      const channelBase = channelIndex * level.entryCount
      const firstEntry = Math.floor(first / level.granularity)
      const lastEntry = Math.min(level.entryCount,
        Math.ceil(last / level.granularity))
      for (let entry = firstEntry; entry < lastEntry; ++entry) {
        if (level.minima[channelBase + entry] < minimum)
          minimum = level.minima[channelBase + entry]
        if (level.maxima[channelBase + entry] > maximum)
          maximum = level.maxima[channelBase + entry]
      }
    } else {
      for (let frame = first; frame < last; ++frame) {
        const value = pyramid.samples[frame * channelCount + channelIndex]
        if (value < minimum) minimum = value
        if (value > maximum) maximum = value
      }
    }
    const low = minimum * factor
    const high = maximum * factor
    minima[bucket] = low
    maxima[bucket] = high
    if (low < captureMinimum) captureMinimum = low
    if (high > captureMaximum) captureMaximum = high
  }

  const scale = expandedRange(verticalRange ?? {
    minimum: captureMinimum,
    maximum: captureMaximum,
  })
  const span = scale.maximum - scale.minimum
  const point = (bucket: number, value: number) => {
    const x = bucketCount === 1 ? 0 : bucket / (bucketCount - 1) * width
    const y = height - (value - scale.minimum) / span * height
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }
  const upper = maxima.map((value, bucket) => point(bucket, value))
  const lower = minima.map((value, bucket) => point(bucket, value)).reverse()
  return {
    minimum: captureMinimum,
    maximum: captureMaximum,
    scaleMinimum: scale.minimum,
    scaleMaximum: scale.maximum,
    points: [...upper, ...lower].join(' '),
  }
}

export function waveformEnvelope(
  waveform: ParsedWaveform,
  channelIndex: number,
  converted: boolean,
  width = 1200,
  height = 88,
  firstFrame = 0,
  lastFrame = waveform.frameCount,
  verticalRange?: WaveformRange,
): WaveformEnvelope {
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
      const value = sampleValue(waveform, frame, channelIndex, converted)
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
    minima[bucket] = minimum
    maxima[bucket] = maximum
    captureMinimum = Math.min(captureMinimum, minimum)
    captureMaximum = Math.max(captureMaximum, maximum)
  }

  const scale = expandedRange(verticalRange ?? {
    minimum: captureMinimum,
    maximum: captureMaximum,
  })
  const span = scale.maximum - scale.minimum
  const point = (bucket: number, value: number) => {
    const x = bucketCount === 1 ? 0 : bucket / (bucketCount - 1) * width
    const y = height - (value - scale.minimum) / span * height
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }
  const upper = maxima.map((value, bucket) => point(bucket, value))
  const lower = minima.map((value, bucket) => point(bucket, value)).reverse()
  return {
    minimum: captureMinimum,
    maximum: captureMaximum,
    scaleMinimum: scale.minimum,
    scaleMaximum: scale.maximum,
    points: [...upper, ...lower].join(' '),
  }
}
