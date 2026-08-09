# MSAP1 web interface

React, TypeScript, and Vite frontend for the MSAP1 meter API. The UI displays
PL-calculated RMS current for ILA, ILB, ILC, and ILN, plus RMS voltage for VLA,
VLB, and VLC through `GET /api/v1/meter/readings`. CH7/VCM remains available
in the API model for future reference monitoring but is not rendered.

The viewer-facing **About** tab displays the MNCOS/Yocto version, short image
build identifier, and software build date from `/api/v1/about`.

The main **Dashboard** contains live RMS readings and pipeline health. The
meter produces two cycle-defined measurement tiers, and an **Update rate**
selector in the "RMS readings" heading chooses which one the dashboard renders:

- **Basic (10/12-cycle)** reads `GET /api/v1/meter/readings`. This is the
  IEC 61000-4-30 basic measurement block: 10 grid cycles at 50 Hz nominal and
  12 at 60 Hz. Its duration tracks the grid (~200 ms nominal) and is never
  defined as a fixed 200 ms period. When the meter reports block timing the
  heading shows the active cycle count, nominal frequency, and time quality;
  older records without timing metadata fall back to the generic
  "Basic measurement block (10/12 cycles)" wording.
- **150/180-cycle** reads `GET /api/v1/meter/aggregate`, polled once per second
  and only while that tier is selected. The aggregate combines exactly 15
  consecutive basic measurement blocks into 150 cycles at 50 Hz nominal or 180
  at 60 Hz (~3 s nominal). It carries RMS per channel but no mean correction
  and no RMS count, so those card fields are omitted rather than zero-filled.
  A provenance strip shows the cycle count and nominal frequency, the basic
  block composition, the first..last basic sequence span, the aggregate age,
  the time quality, and an arithmetic-error warning when the aggregation
  saturated. Sparkline history is kept separately for this tier and extends
  only when the aggregate sequence advances.

Before the first aggregate exists the endpoint returns `available: false`; the
dashboard then shows a plain waiting state explaining that 15 consecutive
eligible basic blocks are needed. This is not an acquisition failure and does
not degrade system health.

The aggregate grid frequency is **informative only**. Per
IEC 61000-4-30:2025 the standardized frequency product is defined over its own
10 s interval, which is not this tier, so the aggregate frequency card is
labelled informative and is never presented as a Class A frequency
measurement. Meter controls are separated under the administrator-only
**Configuration → Meter** view, including the grid-frequency zero-crossing
settings, the declared nominal grid frequency selector (50 Hz or 60 Hz),
which chooses the IEC 61000-4-30 basic measurement block of 10 or 12 cycles,
and the generator signal frequency that drives the ADC simulator source.

Administrators can open **Developer → Overview** to monitor the ZynqMP LPD,
FPD, and PL temperatures discovered from their Linux hwmon labels, together
with the PL clock/rate and DMA acquisition counters moved out of the meter
view. The live cards retain a short browser-side history without adding
another target-side database.

**Developer → About** reports diagnostic MD5 fingerprints for the deployed PL
bitstream, both R5 firmware images, and the APU executables. These values help
identify deployed files; they are not security or integrity guarantees.

**Developer → Logs** presents the acquisition, web-backend/nginx, and firmware
lifecycle journal in one time-ordered view. The page supports component,
module, and severity filters, a normalized raw JSON view, and bounded live
updates using journald cursors. Journal access is provided only through the
authenticated backend API; the browser never reads the system journal
directly.

Administrators can open **Configuration → Waveform** to inspect raw history
capacity, sequence continuity, and completed sessions, then trigger a manual
pre/post capture. The browser sends only the trigger request; the acquisition
daemon owns the dedicated waveform DMA, history, time correlation, and file
materialization.

**Developer → Tweak** exposes the acquisition sample-rate selector (1 to
128 kSPS from the APU's supported set, factory default 128 kSPS). Changing
the rate restarts capture, so it lives in the administrator-only Developer
view rather than Configuration.

**Developer → ADC Simulator** selects physical or simulated raw input and
edits per-channel RMS amplitude and phase for CH0 through CH6; the generator
signal frequency is edited under Configuration → Meter. The backend applies
changes through the acquisition daemon's transactional RPU/PL configuration
path; the browser never accesses simulator registers directly. Source
selection is a developer diagnostic, so it is no longer offered under
Configuration.

Node.js 20.19 or newer is required (the Yocto recipe currently builds with
Node.js 20.20).

```sh
npm ci
npm run build
```

For development, run `npm run dev`. Vite proxies `/api` to
`http://localhost:8080`. The target build is installed under
`/usr/share/msap1-web` and served by nginx.

The initial development login is `admin` / `admin`. Replace this temporary
authentication provider before production deployment.
