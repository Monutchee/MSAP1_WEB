import { createElement } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WaveformViewer, waveformPlotGroups } from './WaveformViewer'
import { buildWaveformPyramid, type ParsedWaveform } from './waveformFile'

const channels = [
  { kind: 'current' as const }, { kind: 'current' as const },
  { kind: 'voltage' as const }, { kind: 'voltage' as const },
  { kind: 'debug' as const },
]

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function testWaveform(): ParsedWaveform {
  const frameCount = 64
  const buffer = new ArrayBuffer(frameCount * 4)
  const data = new DataView(buffer)
  for (let frame = 0; frame < frameCount; ++frame)
    data.setInt32(frame * 4, Math.round(Math.sin(frame / 4) * 1000), true)
  return {
    version: 5,
    sessionId: 1n,
    firstSequence: 0n,
    lastSequence: BigInt(frameCount - 1),
    triggerSequence: 32n,
    triggerTaiNanoseconds: 0n,
    triggerRealtimeNanoseconds: 0n,
    sampleRateHz: 64,
    decimation: 1,
    effectiveSampleRateHz: 64,
    frameCount,
    frameBytes: 4,
    frameDataOffset: 0,
    channels: [{
      sourceChannel: 0,
      name: 'Ia',
      unit: 'A',
      kind: 'current',
      conversionScale: 1,
      conversionOffset: 0,
      conversionValid: true,
    }],
    events: [],
    timebaseSegments: [{
      firstFrame: 0,
      frameCount,
      firstSequence: 0n,
      sequenceStep: 1n,
      sourceFrameCount: BigInt(frameCount),
      acquisitionRateHz: 64,
      persistedRateHz: 64,
      decimation: 1,
    }],
    data,
  }
}

describe('waveform plot layouts', () => {
  it('builds separate, electrical, and global overlays from enabled channels', () => {
    const enabled = new Set([0, 1, 2, 3, 4])
    expect(waveformPlotGroups(channels, enabled, 'separate').map(
      (group) => group.indices)).toEqual([[0], [1], [2], [3], [4]])
    expect(waveformPlotGroups(channels, enabled, 'electrical').map(
      (group) => [group.label, group.indices])).toEqual([
      ['Current channels', [0, 1]],
      ['Voltage channels', [2, 3]],
      ['Other channels', [4]],
    ])
    expect(waveformPlotGroups(channels, enabled, 'overlay').map(
      (group) => group.indices)).toEqual([[0, 1, 2, 3, 4]])
  })

  it('omits disabled channels from every layout', () => {
    expect(waveformPlotGroups(channels, new Set([1, 3]), 'electrical').map(
      (group) => group.indices)).toEqual([[1], [3]])
  })
})

describe('waveform viewport rendering', () => {
  it('draws numeric envelopes on canvas and coalesces wheel zoom per frame', () => {
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      stroke: vi.fn(),
      fillStyle: '',
      globalAlpha: 1,
      lineWidth: 1,
      strokeStyle: '',
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context)
    let frameCallback: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback
      return 1
    })
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const waveform = testWaveform()
    const onClose = vi.fn()
    const previousOverflow = document.body.style.overflow
    const { baseElement, unmount } = render(createElement(WaveformViewer, {
      filename: 'test.mncwf',
      waveform,
      pyramid: buildWaveformPyramid(waveform, 1),
      onClose,
    }))
    const dialog = baseElement.querySelector('[role="dialog"]') as HTMLElement
    const backdrop = baseElement.querySelector('.waveform-viewer-backdrop') as HTMLDivElement
    const plot = baseElement.querySelector('.waveform-plot-canvas') as HTMLDivElement
    vi.spyOn(plot, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 88,
      width: 1200, height: 88, toJSON: () => ({}),
    })

    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveFocus()
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(baseElement.querySelector('.waveform-viewer-header button'))
      .toHaveFocus()
    fireEvent.click(dialog)
    expect(onClose).not.toHaveBeenCalled()
    expect(baseElement.querySelector('.waveform-envelope-canvas')).not.toBeNull()
    expect(baseElement.querySelector('polygon')).toBeNull()
    expect(context.lineTo).toHaveBeenCalled()
    fireEvent.wheel(plot, { deltaY: -100, clientX: 600 })
    fireEvent.wheel(plot, { deltaY: -100, clientX: 600 })

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(baseElement.querySelector('.waveform-viewer-footer'))
      .toHaveTextContent('64 frames')
    act(() => frameCallback?.(0))
    expect(baseElement.querySelector('.waveform-viewer-footer'))
      .toHaveTextContent('35 frames')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)
    unmount()
    expect(document.body.style.overflow).toBe(previousOverflow)
  })
})
