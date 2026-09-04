export type WaveformChannelKind = 'current' | 'voltage' | 'debug'

export interface WaveformChannel {
  sourceChannel: number
  name: string
  unit: string
  kind: WaveformChannelKind
  /** Affine conversion from a stored ADC word to the declared SI unit. */
  conversionScale: number
  conversionOffset: number
  conversionValid: boolean
}

export interface WaveformEvent {
  sequence: bigint
  taiNanoseconds: bigint
  source: number
}

export interface WaveformTimebaseSegment {
  firstFrame: number
  frameCount: number
  firstSequence: bigint
  sequenceStep: bigint
  sourceFrameCount: bigint
  acquisitionRateHz: number
  persistedRateHz: number
  decimation: number
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
  timebaseSegments: WaveformTimebaseSegment[]
  data: DataView
}

const MAGIC = [0x4d, 0x4e, 0x43, 0x57, 0x46, 0x31, 0, 0]
const CHANNEL_DESCRIPTOR_BYTES = 32
const EVENT_BYTES = 24
const V4_HEADER_BYTES = 64
const V4_DIRECTORY_ENTRY_BYTES = 56
const V4_SECTION_HEADER_BYTES = 48
const V4_REQUIRED_SECTION_COUNT = 7
const V4_SECTION_REQUIRED = 1
const V5_CHUNK_ENTRY_BYTES = 56
const V5_MAX_CHUNK_LOGICAL_BYTES = 1024 * 1024
const V5_MAX_CHUNKS = 4096
const MNCWF_MAX_FILE_BYTES = 512 * 1024 * 1024

interface V4Section {
  type: number
  version: number
  flags: number
  offset: number
  storedBytes: number
  logicalBytes: number
  itemCount: number
  itemBytes: number
  crc32c: number
}

interface V4SectionEnvelope {
  recordsOffset: number
  blobOffset: number
  blobBytes: number
}

interface V5Chunk {
  firstFrame: number
  frameCount: number
  storedOffset: number
  storedBytes: number
  logicalBytes: number
  codec: 0 | 1
  logicalCrc32c: number
}

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

function alignEight(value: number) {
  return Math.ceil(value / 8) * 8
}

function bytes(data: DataView, offset: number, length: number) {
  requireRange(data.byteLength, offset, length, 'byte')
  return new Uint8Array(data.buffer, data.byteOffset + offset, length)
}

const CRC32C_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; ++bit)
    crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f6_3b78 : 0)
  return crc >>> 0
})

/** Reflected CRC-32C (Castagnoli), matching the normative MNCWF v4 reader. */
function crc32c(octets: Uint8Array) {
  let crc = 0xffff_ffff
  for (const octet of octets)
    crc = CRC32C_TABLE[(crc ^ octet) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffff_ffff) >>> 0
}

function littleUnsigned(octets: Uint8Array, offset: number, length: number) {
  requireRange(octets.byteLength, offset, length, 'Zstd frame header')
  let value = 0n
  for (let index = 0; index < length; ++index)
    value |= BigInt(octets[offset + index]) << BigInt(index * 8)
  return value
}

/** Reject frames that could ask the WASM decoder for an oversized window. */
function validateZstdFrame(
  frame: Uint8Array,
  expectedLogicalBytes: number,
) {
  if (frame.byteLength < 6 || frame[0] !== 0x28 || frame[1] !== 0xb5 ||
      frame[2] !== 0x2f || frame[3] !== 0xfd)
    throw new Error('Invalid Zstd frame magic in MNCWF v5 chunk')
  const descriptor = frame[4]
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const dictionaryFlag = descriptor & 0x03
  if ((descriptor & 0x18) !== 0 || (descriptor & 0x04) === 0 ||
      dictionaryFlag !== 0)
    throw new Error('Unsupported Zstd frame options in MNCWF v5 chunk')
  let cursor = 5
  let windowBytes: number | undefined
  if (!singleSegment) {
    requireRange(frame.byteLength, cursor, 1, 'Zstd window descriptor')
    const windowDescriptor = frame[cursor++]
    const windowBase = 2 ** (10 + (windowDescriptor >>> 3))
    windowBytes = windowBase + (windowBase >>> 3) * (windowDescriptor & 7)
  }
  const contentSizeBytes = contentSizeFlag === 0
    ? (singleSegment ? 1 : 0) : 2 ** contentSizeFlag
  if (contentSizeBytes === 0)
    throw new Error('MNCWF v5 Zstd frame omits its content size')
  let contentSize = littleUnsigned(frame, cursor, contentSizeBytes)
  cursor += contentSizeBytes
  if (contentSizeBytes === 2) contentSize += 256n
  if (contentSize !== BigInt(expectedLogicalBytes))
    throw new Error('MNCWF v5 Zstd frame content size is invalid')
  windowBytes ??= safeNumber(contentSize, 'Zstd window size')
  if (windowBytes > V5_MAX_CHUNK_LOGICAL_BYTES)
    throw new Error('MNCWF v5 Zstd window exceeds the 1 MiB limit')

  let lastBlock = false
  while (!lastBlock) {
    requireRange(frame.byteLength, cursor, 3, 'Zstd block header')
    const blockHeader = frame[cursor] | (frame[cursor + 1] << 8) |
      (frame[cursor + 2] << 16)
    cursor += 3
    lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    if (blockType === 3)
      throw new Error('MNCWF v5 Zstd frame contains a reserved block type')
    const payloadBytes = blockType === 1 ? 1 : blockSize
    requireRange(frame.byteLength, cursor, payloadBytes, 'Zstd block payload')
    cursor += payloadBytes
  }
  requireRange(frame.byteLength, cursor, 4, 'Zstd content checksum')
  cursor += 4
  if (cursor !== frame.byteLength)
    throw new Error('MNCWF v5 chunk must contain exactly one Zstd frame')
}

function validateV5SampleSection(data: DataView, section: V4Section) {
  if (section.version !== 2 || section.flags !== V4_SECTION_REQUIRED ||
      section.itemBytes === 0 || section.itemBytes > V5_MAX_CHUNK_LOGICAL_BYTES ||
      section.itemCount === 0 || section.logicalBytes > MNCWF_MAX_FILE_BYTES ||
      section.storedBytes < V4_SECTION_HEADER_BYTES ||
      data.getUint32(section.offset, true) !== 7 ||
      data.getUint16(section.offset + 4, true) !== 2 ||
      data.getUint16(section.offset + 6, true) !== V4_SECTION_HEADER_BYTES ||
      data.getUint32(section.offset + 8, true) !== 0 ||
      data.getUint32(section.offset + 12, true) !== section.itemBytes ||
      safeNumber(data.getBigUint64(section.offset + 16, true),
        'v5 sample count') !== section.itemCount ||
      data.getBigUint64(section.offset + 24, true) !== 48n ||
      data.getBigUint64(section.offset + 40, true) !== 0n)
    throw new Error('Invalid MNCWF v5 sample-section envelope')
  const tableBytes = safeNumber(data.getBigUint64(section.offset + 32, true),
    'v5 chunk table bytes')
  if (tableBytes === 0 || tableBytes % V5_CHUNK_ENTRY_BYTES !== 0)
    throw new Error('Invalid MNCWF v5 chunk-table geometry')
  requireRange(section.storedBytes, V4_SECTION_HEADER_BYTES, tableBytes,
    'v5 chunk table')
  const chunkCount = tableBytes / V5_CHUNK_ENTRY_BYTES
  if (chunkCount > V5_MAX_CHUNKS)
    throw new Error('MNCWF v5 chunk count exceeds the allocation bound')
  const chunks: V5Chunk[] = []
  let expectedFirstFrame = 0
  let expectedStoredOffset = alignEight(V4_SECTION_HEADER_BYTES + tableBytes)
  for (let index = 0; index < chunkCount; ++index) {
    const entry = section.offset + V4_SECTION_HEADER_BYTES +
      index * V5_CHUNK_ENTRY_BYTES
    const firstFrame = safeNumber(data.getBigUint64(entry, true),
      'v5 chunk first frame')
    const frameCount = safeNumber(data.getBigUint64(entry + 8, true),
      'v5 chunk frame count')
    const storedOffset = safeNumber(data.getBigUint64(entry + 16, true),
      'v5 chunk stored offset')
    const storedBytes = safeNumber(data.getBigUint64(entry + 24, true),
      'v5 chunk stored bytes')
    const logicalBytes = safeNumber(data.getBigUint64(entry + 32, true),
      'v5 chunk logical bytes')
    const codec = data.getUint16(entry + 40, true)
    const flags = data.getUint16(entry + 42, true)
    const expectedLogical = frameCount * section.itemBytes
    if (!Number.isSafeInteger(expectedLogical) || firstFrame !== expectedFirstFrame ||
        frameCount === 0 || logicalBytes !== expectedLogical ||
        logicalBytes > V5_MAX_CHUNK_LOGICAL_BYTES ||
        storedOffset !== expectedStoredOffset || storedBytes === 0 ||
        data.getBigUint64(entry + 48, true) !== 0n ||
        (codec !== 0 && codec !== 1) ||
        (codec === 0
          ? flags !== 0 || storedBytes !== logicalBytes
          : flags !== 1 || storedBytes >= logicalBytes))
      throw new Error('Invalid MNCWF v5 sample chunk')
    requireRange(section.storedBytes, storedOffset, storedBytes,
      'v5 stored chunk')
    const stored = bytes(data, section.offset + storedOffset, storedBytes)
    if (codec === 1) validateZstdFrame(stored, logicalBytes)
    const storedEnd = storedOffset + storedBytes
    expectedStoredOffset = alignEight(storedEnd)
    if (expectedStoredOffset > section.storedBytes)
      throw new Error('MNCWF v5 chunk alignment exceeds the sample section')
    for (const value of bytes(data, section.offset + storedEnd,
      expectedStoredOffset - storedEnd))
      if (value !== 0) throw new Error('Nonzero MNCWF v5 chunk padding')
    chunks.push({
      firstFrame, frameCount, storedOffset, storedBytes, logicalBytes,
      codec: codec as 0 | 1,
      logicalCrc32c: data.getUint32(entry + 44, true),
    })
    expectedFirstFrame += frameCount
  }
  if (expectedFirstFrame !== section.itemCount ||
      expectedStoredOffset !== section.storedBytes)
    throw new Error('Incomplete MNCWF v5 chunk coverage')
  return chunks
}

function finiteRatio(numerator: bigint, denominator: bigint, label: string) {
  if (denominator === 0n) throw new Error(`Invalid ${label} denominator in waveform file`)
  const value = Number(numerator) / Number(denominator)
  if (!Number.isFinite(value)) throw new Error(`Invalid ${label} in waveform file`)
  return value
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
    conversionScale: 0,
    conversionOffset: 0,
    conversionValid: false,
  }))
}

function parseV4SectionEnvelope(
  data: DataView,
  section: V4Section,
  expectedItemBytes: number,
  minimumCount: number,
  maximumCount: number,
  allowBlob: boolean,
): V4SectionEnvelope {
  if (section.version !== 1 || section.flags !== V4_SECTION_REQUIRED ||
      section.itemBytes !== expectedItemBytes ||
      section.itemCount < minimumCount || section.itemCount > maximumCount)
    throw new Error('Invalid MNCWF v4 mandatory-section geometry')
  requireRange(data.byteLength, section.offset, section.storedBytes, 'v4 section')
  if (section.storedBytes < V4_SECTION_HEADER_BYTES ||
      data.getUint32(section.offset, true) !== section.type ||
      data.getUint16(section.offset + 4, true) !== section.version ||
      data.getUint16(section.offset + 6, true) !== V4_SECTION_HEADER_BYTES ||
      data.getUint32(section.offset + 8, true) !== 0 ||
      data.getUint32(section.offset + 12, true) !== section.itemBytes ||
      safeNumber(data.getBigUint64(section.offset + 16, true), 'v4 record count') !==
        section.itemCount ||
      data.getBigUint64(section.offset + 40, true) !== 0n)
    throw new Error('Invalid MNCWF v4 section envelope')

  const recordsBytes = section.itemCount * section.itemBytes
  if (!Number.isSafeInteger(recordsBytes))
    throw new Error('MNCWF v4 section records exceed browser-safe range')
  const recordsEnd = V4_SECTION_HEADER_BYTES + recordsBytes
  const blobOffset = safeNumber(
    data.getBigUint64(section.offset + 24, true), 'v4 section blob offset')
  const blobBytes = safeNumber(
    data.getBigUint64(section.offset + 32, true), 'v4 section blob bytes')
  if (blobBytes === 0) {
    if (blobOffset !== 0 || recordsEnd !== section.storedBytes)
      throw new Error('Invalid MNCWF v4 section without a blob')
  } else {
    if (!allowBlob || blobOffset !== alignEight(recordsEnd) ||
        blobOffset + blobBytes !== section.storedBytes)
      throw new Error('Invalid MNCWF v4 section blob geometry')
    for (const value of bytes(data, section.offset + recordsEnd,
      blobOffset - recordsEnd))
      if (value !== 0) throw new Error('Nonzero MNCWF v4 section padding')
  }
  requireRange(data.byteLength, section.offset + V4_SECTION_HEADER_BYTES,
    recordsBytes, 'v4 section records')
  if (blobBytes > 0)
    requireRange(data.byteLength, section.offset + blobOffset, blobBytes,
      'v4 section blob')
  return {
    recordsOffset: section.offset + V4_SECTION_HEADER_BYTES,
    blobOffset: blobBytes ? section.offset + blobOffset : 0,
    blobBytes,
  }
}

function v4String(
  data: DataView,
  recordOffset: number,
  referenceOffset: number,
  section: V4SectionEnvelope,
  label: string,
) {
  const offset = data.getUint32(recordOffset + referenceOffset, true)
  const length = data.getUint32(recordOffset + referenceOffset + 4, true)
  if (length > 64 * 1024 || (length === 0 && offset !== 0) ||
      offset > section.blobBytes || length > section.blobBytes - offset)
    throw new Error(`Invalid ${label} string in MNCWF v4 file`)
  if (length === 0) return ''
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      bytes(data, section.blobOffset + offset, length))
  } catch {
    throw new Error(`Invalid UTF-8 in MNCWF v4 ${label}`)
  }
}

function parseSectionDirectory(data: DataView, formatVersion: 4 | 5) {
  requireRange(data.byteLength, 0, V4_HEADER_BYTES, 'v4 header')
  if (data.byteLength > MNCWF_MAX_FILE_BYTES ||
      data.getUint32(12, true) !== V4_HEADER_BYTES ||
      data.getUint32(16, true) !== V4_DIRECTORY_ENTRY_BYTES)
    throw new Error('Unsupported MNCWF v4/v5 header geometry')
  const sectionCount = data.getUint32(20, true)
  const directoryOffset = safeNumber(
    data.getBigUint64(24, true), 'v4 directory offset')
  const directoryBytes = safeNumber(
    data.getBigUint64(32, true), 'v4 directory bytes')
  const fileBytes = safeNumber(data.getBigUint64(40, true), 'v4 file bytes')
  if (sectionCount < V4_REQUIRED_SECTION_COUNT || sectionCount > 64 ||
      directoryOffset !== V4_HEADER_BYTES ||
      directoryBytes !== sectionCount * V4_DIRECTORY_ENTRY_BYTES ||
      fileBytes !== data.byteLength || data.getUint32(48, true) !== 0 ||
      data.getUint32(60, true) !== 0)
    throw new Error('Invalid MNCWF v4/v5 file geometry')
  requireRange(data.byteLength, directoryOffset, directoryBytes, 'v4 directory')

  const header = bytes(data, 0, V4_HEADER_BYTES).slice()
  header.fill(0, 56, 60)
  if (crc32c(header) !== data.getUint32(56, true))
    throw new Error('MNCWF v4/v5 header CRC32C mismatch')
  if (crc32c(bytes(data, directoryOffset, directoryBytes)) !==
      data.getUint32(52, true))
    throw new Error('MNCWF v4/v5 directory CRC32C mismatch')

  const sections: V4Section[] = []
  const known = new Map<number, V4Section>()
  for (let index = 0; index < sectionCount; ++index) {
    const offset = directoryOffset + index * V4_DIRECTORY_ENTRY_BYTES
    const section: V4Section = {
      type: data.getUint32(offset, true),
      version: data.getUint16(offset + 4, true),
      flags: data.getUint16(offset + 6, true),
      offset: safeNumber(data.getBigUint64(offset + 8, true), 'v4 section offset'),
      storedBytes: safeNumber(
        data.getBigUint64(offset + 16, true), 'v4 section bytes'),
      logicalBytes: safeNumber(
        data.getBigUint64(offset + 24, true), 'v4 logical bytes'),
      itemCount: safeNumber(
        data.getBigUint64(offset + 32, true), 'v4 section item count'),
      itemBytes: data.getUint32(offset + 40, true),
      crc32c: data.getUint32(offset + 44, true),
    }
    const sampleSection = section.type === 7
    const logicalProduct = section.itemCount * section.itemBytes
    const validSectionVersion = sampleSection
      ? section.version === (formatVersion === 5 ? 2 : 1)
      : section.type <= 6 ? section.version === 1 : true
    const validLogicalBytes = formatVersion === 5 && sampleSection
      ? Number.isSafeInteger(logicalProduct) &&
        section.logicalBytes === logicalProduct &&
        section.logicalBytes <= MNCWF_MAX_FILE_BYTES
      : section.logicalBytes === section.storedBytes
    if (section.type === 0 || section.version === 0 ||
        (section.flags & ~V4_SECTION_REQUIRED) !== 0 ||
        section.storedBytes === 0 || !validSectionVersion || !validLogicalBytes ||
        (section.offset & 7) !== 0 || data.getBigUint64(offset + 48, true) !== 0n)
      throw new Error('Invalid MNCWF v4/v5 directory entry')
    const isKnown = section.type >= 1 && section.type <= 7
    if (!isKnown && (section.flags & V4_SECTION_REQUIRED) !== 0)
      throw new Error('Unsupported required MNCWF v4/v5 section')
    if (isKnown) {
      if (known.has(section.type) || section.flags !== V4_SECTION_REQUIRED)
        throw new Error('Invalid duplicate or optional MNCWF v4/v5 section')
      known.set(section.type, section)
    }
    requireRange(data.byteLength, section.offset, section.storedBytes, 'v4 section')
    if (crc32c(bytes(data, section.offset, section.storedBytes)) !== section.crc32c)
      throw new Error('MNCWF v4/v5 section CRC32C mismatch')
    sections.push(section)
  }
  if (known.size !== V4_REQUIRED_SECTION_COUNT)
    throw new Error('MNCWF v4/v5 mandatory section is missing')

  const extents = sections.map((section) => ({
    first: section.offset, last: section.offset + section.storedBytes,
  })).sort((left, right) => left.first - right.first)
  let cursor = alignEight(directoryOffset + directoryBytes)
  for (const extent of extents) {
    if (extent.first !== cursor)
      throw new Error('Invalid MNCWF v4/v5 section coverage')
    const aligned = alignEight(extent.last)
    for (const value of bytes(data, extent.last, aligned - extent.last))
      if (value !== 0) throw new Error('Nonzero MNCWF v4/v5 alignment padding')
    cursor = aligned
  }
  if (cursor !== data.byteLength)
    throw new Error('Unreferenced bytes follow MNCWF v4/v5 sections')
  return known
}

function parseWaveformV4(data: DataView, decompressedSamples?: ArrayBuffer): ParsedWaveform {
  const formatVersion = data.getUint32(8, true)
  if (formatVersion !== 4 && formatVersion !== 5)
    throw new Error(`Unsupported MNCWF version ${formatVersion}`)
  const known = parseSectionDirectory(data, formatVersion)

  const captureSection = known.get(1)!
  const capture = parseV4SectionEnvelope(
    data, captureSection, 256, 1, 1, true)
  const captureRecord = capture.recordsOffset
  const createdTaiNanoseconds = data.getBigUint64(captureRecord + 96, true)
  const createdUtcNanoseconds = data.getBigUint64(captureRecord + 104, true)

  const timeSection = known.get(2)!
  const time = parseV4SectionEnvelope(
    data, timeSection, 128, 1, 65_536, false)
  const timebaseSegments: WaveformTimebaseSegment[] = []
  let expectedFirstFrame = 0
  for (let index = 0; index < timeSection.itemCount; ++index) {
    const record = time.recordsOffset + index * timeSection.itemBytes
    const firstFrame = safeNumber(data.getBigUint64(record, true), 'v4 first frame')
    const frameCount = safeNumber(data.getBigUint64(record + 8, true), 'v4 frame count')
    const firstSequence = data.getBigUint64(record + 16, true)
    const sequenceStep = data.getBigUint64(record + 24, true)
    const acquisitionRateNumerator = data.getBigUint64(record + 32, true)
    const acquisitionRateDenominator = data.getBigUint64(record + 40, true)
    const persistedRateNumerator = data.getBigUint64(record + 48, true)
    const persistedRateDenominator = data.getBigUint64(record + 56, true)
    const decimation = data.getUint32(record + 104, true)
    const sourceFrameCount = data.getBigUint64(record + 120, true)
    if (firstFrame !== expectedFirstFrame || frameCount === 0 ||
        sequenceStep === 0n || sourceFrameCount === 0n ||
        decimation === 0 || decimation > 65_536)
      throw new Error('Invalid MNCWF v4 timebase segment')
    const acquisitionRateHz = finiteRatio(
      acquisitionRateNumerator, acquisitionRateDenominator, 'acquisition rate')
    const persistedRateHz = finiteRatio(
      persistedRateNumerator, persistedRateDenominator, 'persisted rate')
    if (acquisitionRateHz <= 0 || persistedRateHz <= 0)
      throw new Error('Invalid MNCWF v4 sample rate')
    timebaseSegments.push({
      firstFrame, frameCount, firstSequence, sequenceStep, sourceFrameCount,
      acquisitionRateHz, persistedRateHz, decimation,
    })
    expectedFirstFrame += frameCount
  }

  const channelSection = known.get(3)!
  const channelEnvelope = parseV4SectionEnvelope(
    data, channelSection, 208, 1, 64, true)
  const channels: WaveformChannel[] = []
  let expectedFrameBytes = 0
  for (let index = 0; index < channelSection.itemCount; ++index) {
    const record = channelEnvelope.recordsOffset + index * channelSection.itemBytes
    const flags = data.getUint32(record + 20, true)
    const quantity = data.getUint16(record + 26, true)
    const unit = data.getUint16(record + 28, true)
    const encoding = data.getUint16(record + 30, true)
    const storageBits = data.getUint16(record + 32, true)
    const validBits = data.getUint16(record + 34, true)
    if ((flags & 1) === 0 || encoding !== 1 || storageBits !== 32 ||
        validBits === 0 || validBits > storageBits)
      throw new Error('The browser viewer supports only enabled signed 32-bit MNCWF v4 channels')
    const conversionValid = (flags & 2) !== 0
    const gainDenominator = data.getBigUint64(record + 48, true)
    const offsetDenominator = data.getBigUint64(record + 64, true)
    const conversionScale = conversionValid
      ? finiteRatio(data.getBigInt64(record + 40, true), gainDenominator,
          'channel gain')
      : 0
    const conversionOffset = conversionValid
      ? finiteRatio(data.getBigInt64(record + 56, true), offsetDenominator,
          'channel offset')
      : 0
    const fallbackUnit = unit === 1 ? 'A' : unit === 2 ? 'V' : unit === 3 ? 'Hz' : 'value'
    channels.push({
      sourceChannel: data.getUint32(record + 16, true),
      kind: quantity === 1 ? 'current' : quantity === 2 ? 'voltage' : 'debug',
      conversionScale,
      conversionOffset,
      conversionValid,
      name: v4String(data, record, 168, channelEnvelope, 'channel name') || `CH${index}`,
      unit: v4String(data, record, 176, channelEnvelope, 'channel unit') || fallbackUnit,
    })
    expectedFrameBytes += storageBits / 8
  }

  const eventSection = known.get(4)!
  const eventEnvelope = parseV4SectionEnvelope(
    data, eventSection, 256, 0, 4096, true)
  const events: WaveformEvent[] = []
  let primaryTrigger: { sequence: bigint; tai: bigint; utc: bigint } | undefined
  let primaryHasTrigger = false
  for (let index = 0; index < eventSection.itemCount; ++index) {
    const record = eventEnvelope.recordsOffset + index * eventSection.itemBytes
    const flags = data.getUint32(record + 24, true)
    if ((flags & 1) === 0)
      throw new Error('Invalid MNCWF v4 event without a start anchor')
    const startSequence = data.getBigUint64(record + 48, true)
    const hasTrigger = (flags & 8) !== 0
    const sequence = hasTrigger
      ? data.getBigUint64(record + 72, true) : startSequence
    const tai = (flags & 16) !== 0
      ? data.getBigUint64(record + (hasTrigger ? 104 : 80), true) : 0n
    const utc = (flags & 32) !== 0
      ? data.getBigUint64(record + (hasTrigger ? 136 : 112), true) : 0n
    events.push({
      sequence,
      taiNanoseconds: tai,
      source: data.getUint16(record + 36, true),
    })
    if (!primaryTrigger || (hasTrigger && !primaryHasTrigger))
      primaryTrigger = { sequence, tai, utc }
    primaryHasTrigger ||= hasTrigger
  }

  // These sections are not rendered yet, but their envelopes and CRCs remain
  // part of accepting a complete v4 master record.
  parseV4SectionEnvelope(data, known.get(5)!, 64, 0,
    Math.floor(16 * 1024 * 1024 / 64), false)
  parseV4SectionEnvelope(data, known.get(6)!, 64, 0, 4096, false)

  const sampleSection = known.get(7)!
  if (sampleSection.itemBytes !== expectedFrameBytes)
    throw new Error('MNCWF v4 sample frame size disagrees with its channels')
  let sampleData = data
  let frameDataOffset: number
  if (formatVersion === 4) {
    const samples = parseV4SectionEnvelope(data, sampleSection,
      expectedFrameBytes, 1, Math.floor(data.byteLength / expectedFrameBytes), false)
    frameDataOffset = samples.recordsOffset
  } else {
    validateV5SampleSection(data, sampleSection)
    if (!decompressedSamples ||
        decompressedSamples.byteLength !== sampleSection.logicalBytes)
      throw new Error('MNCWF v5 samples must be decompressed in the waveform worker')
    sampleData = new DataView(decompressedSamples)
    frameDataOffset = 0
  }
  if (expectedFirstFrame !== sampleSection.itemCount)
    throw new Error('MNCWF v4 timebase does not cover every stored frame')

  const firstTimebase = timebaseSegments[0]
  const lastTimebase = timebaseSegments[timebaseSegments.length - 1]
  const firstSequence = firstTimebase.firstSequence
  const lastSequence = lastTimebase.firstSequence + lastTimebase.sourceFrameCount - 1n
  const triggerSequence = primaryTrigger?.sequence ?? firstSequence
  return {
    version: formatVersion,
    sessionId: 0n,
    firstSequence,
    lastSequence,
    triggerSequence,
    triggerTaiNanoseconds: primaryTrigger?.tai || createdTaiNanoseconds,
    triggerRealtimeNanoseconds: primaryTrigger?.utc || createdUtcNanoseconds,
    sampleRateHz: firstTimebase.acquisitionRateHz,
    decimation: firstTimebase.decimation,
    effectiveSampleRateHz: firstTimebase.persistedRateHz,
    frameCount: sampleSection.itemCount,
    frameBytes: expectedFrameBytes,
    frameDataOffset,
    channels,
    events,
    timebaseSegments,
    data: sampleData,
  }
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
  if (version === 4) return parseWaveformV4(data)
  if (version === 5)
    throw new Error('MNCWF v5 must be opened by the waveform worker')
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
        conversionScale: data.getUint32(offset + 8, true) / 65536 / 1_000_000,
        conversionOffset: 0,
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
    timebaseSegments: [{
      firstFrame: 0,
      frameCount,
      firstSequence,
      sequenceStep: BigInt(decimation),
      sourceFrameCount: lastSequence - firstSequence + 1n,
      acquisitionRateHz: sampleRateHz,
      persistedRateHz: sampleRateHz / decimation,
      decimation,
    }],
    data,
  }
}

interface ZstdDecoderApi {
  decode(array: Uint8Array, uncompressedSize?: number): Uint8Array
}

let zstdDecoder: Promise<ZstdDecoderApi> | undefined

function decoder() {
  zstdDecoder ??= import('zstddec').then(async ({ ZSTDDecoder }) => {
    const instance = new ZSTDDecoder()
    await instance.init()
    return instance
  })
  return zstdDecoder
}

async function decompressWaveformV5(data: DataView) {
  const known = parseSectionDirectory(data, 5)
  const sampleSection = known.get(7)!
  const chunks = validateV5SampleSection(data, sampleSection)
  const logical = new Uint8Array(sampleSection.logicalBytes)
  const zstd = chunks.some((chunk) => chunk.codec === 1)
    ? await decoder() : undefined
  for (const chunk of chunks) {
    const stored = bytes(data, sampleSection.offset + chunk.storedOffset,
      chunk.storedBytes)
    const outputOffset = chunk.firstFrame * sampleSection.itemBytes
    const destination = logical.subarray(outputOffset,
      outputOffset + chunk.logicalBytes)
    if (chunk.codec === 0) {
      destination.set(stored)
    } else {
      const expanded = zstd!.decode(stored, chunk.logicalBytes)
      if (expanded.byteLength !== chunk.logicalBytes)
        throw new Error('MNCWF v5 Zstd chunk decompressed to the wrong size')
      destination.set(expanded)
    }
    if (crc32c(destination) !== chunk.logicalCrc32c)
      throw new Error('MNCWF v5 sample chunk logical CRC32C mismatch')
  }
  return logical.buffer
}

/** Parse every supported MNCWF version; v5 decompression remains asynchronous. */
export async function parseWaveformAsync(buffer: ArrayBuffer) {
  const data = new DataView(buffer)
  requireRange(data.byteLength, 0, 16, 'header')
  for (let index = 0; index < MAGIC.length; ++index) {
    if (data.getUint8(index) !== MAGIC[index])
      throw new Error('The selected file is not an MNCWF waveform')
  }
  if (data.getUint32(8, true) !== 5) return parseWaveform(buffer)
  const samples = await decompressWaveformV5(data)
  return parseWaveformV4(data, samples)
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
  return raw * channel.conversionScale + channel.conversionOffset
}

export function waveformFrameForSequence(
  waveform: ParsedWaveform,
  sequence: bigint,
) {
  for (const segment of waveform.timebaseSegments) {
    const lastSequence = segment.firstSequence + segment.sourceFrameCount - 1n
    if (sequence < segment.firstSequence || sequence > lastSequence) continue
    const local = (sequence - segment.firstSequence) / segment.sequenceStep
    return segment.firstFrame + Math.min(
      segment.frameCount - 1, safeNumber(local, 'waveform frame index'))
  }
  return undefined
}

export function waveformFrameTimeSeconds(waveform: ParsedWaveform, frame: number) {
  const target = Math.max(0, Math.min(waveform.frameCount, frame))
  let seconds = 0
  for (const segment of waveform.timebaseSegments) {
    if (target <= segment.firstFrame)
      return seconds
    const frames = Math.min(segment.frameCount, target - segment.firstFrame)
    seconds += frames / segment.persistedRateHz
    if (frames < segment.frameCount) return seconds
  }
  return seconds
}

export function waveformDurationSeconds(waveform: ParsedWaveform) {
  return waveformFrameTimeSeconds(waveform, waveform.frameCount)
}

export interface WaveformEnvelope {
  minimum: number
  maximum: number
  scaleMinimum: number
  scaleMaximum: number
  points: string
}

/** Numeric min/max buckets used by the interactive canvas renderer. */
export interface WaveformEnvelopeData {
  minimum: number
  maximum: number
  minima: Float64Array
  maxima: Float64Array
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

export function waveformEnvelopeScale(
  envelope: Pick<WaveformEnvelopeData, 'minimum' | 'maximum'>,
  verticalRange?: WaveformRange,
): WaveformRange {
  return expandedRange(verticalRange ?? {
    minimum: envelope.minimum,
    maximum: envelope.maximum,
  })
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
 * The pyramid stores raw ADC counts only. Converted views apply each file's
 * affine transform at query time (and swap the bounds for a negative gain),
 * so the viewer does not need a second full-size pyramid.
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

function displayTransform(
  waveform: ParsedWaveform,
  channelIndex: number,
  converted: boolean,
) {
  const channel = waveform.channels[channelIndex]
  return converted && channel.conversionValid
    ? { scale: channel.conversionScale, offset: channel.conversionOffset }
    : { scale: 1, offset: 0 }
}

function transformedRange(minimum: number, maximum: number, scale: number, offset: number) {
  const first = minimum * scale + offset
  const last = maximum * scale + offset
  return first <= last
    ? { minimum: first, maximum: last }
    : { minimum: last, maximum: first }
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
  const transform = displayTransform(waveform, channelIndex, converted)
  return transformedRange(minimum, maximum, transform.scale, transform.offset)
}

export function pyramidEnvelopeData(
  waveform: ParsedWaveform,
  pyramid: WaveformPyramid,
  channelIndex: number,
  converted: boolean,
  width = 1200,
  firstFrame = 0,
  lastFrame = waveform.frameCount,
): WaveformEnvelopeData {
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
  const transform = displayTransform(waveform, channelIndex, converted)

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

  const minima = new Float64Array(bucketCount)
  const maxima = new Float64Array(bucketCount)
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
    const convertedRange = transformedRange(
      minimum, maximum, transform.scale, transform.offset)
    minima[bucket] = convertedRange.minimum
    maxima[bucket] = convertedRange.maximum
    if (convertedRange.minimum < captureMinimum)
      captureMinimum = convertedRange.minimum
    if (convertedRange.maximum > captureMaximum)
      captureMaximum = convertedRange.maximum
  }

  return { minimum: captureMinimum, maximum: captureMaximum, minima, maxima }
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
  const envelope = pyramidEnvelopeData(
    waveform, pyramid, channelIndex, converted, width, firstFrame, lastFrame,
  )
  const scale = waveformEnvelopeScale(envelope, verticalRange)
  const span = scale.maximum - scale.minimum
  const point = (bucket: number, value: number) => {
    const x = envelope.minima.length === 1
      ? 0 : bucket / (envelope.minima.length - 1) * width
    const y = height - (value - scale.minimum) / span * height
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }
  const upper = Array.from(envelope.maxima,
    (value, bucket) => point(bucket, value))
  const lower = Array.from(envelope.minima,
    (value, bucket) => point(bucket, value)).reverse()
  return {
    minimum: envelope.minimum,
    maximum: envelope.maximum,
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
