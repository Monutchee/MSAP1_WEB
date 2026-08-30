import { describe, expect, it } from 'vitest'
import { waveformPlotGroups } from './WaveformViewer'

const channels = [
  { kind: 'current' as const }, { kind: 'current' as const },
  { kind: 'voltage' as const }, { kind: 'voltage' as const },
  { kind: 'debug' as const },
]

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
