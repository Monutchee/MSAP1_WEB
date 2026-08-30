# MSAP1 web interface

React, TypeScript, and Vite frontend for the MSAP1 meter API. The UI displays
PL-calculated RMS current for ILA, ILB, ILC, and ILN, plus RMS voltage for VLA,
VLB, and VLC through `GET /api/v1/meter/readings`. CH7/VCM remains available
in the API model for future reference monitoring but is not rendered.

The viewer-facing **About** tab displays the MNCOS/Yocto version, short image
build identifier, and software build date from `/api/v1/about`.

The main **Dashboard** contains live RMS readings and pipeline health. The
meter produces two cycle-defined measurement tiers, and a **Measurement
interval**
selector in the "RMS readings" heading chooses which one the dashboard renders:

- **Basic block (10/12 cycles)** reads `GET /api/v1/meter/readings`. This is the
  IEC 61000-4-30 basic measurement block: 10 grid cycles at 50 Hz nominal and
  12 at 60 Hz. Its duration tracks the grid (~200 ms nominal) and is never
  defined as a fixed 200 ms period. When the meter reports block timing the
  heading shows the active cycle count, nominal frequency, and time quality;
  older records without timing metadata fall back to the generic
  "Basic measurement block (10/12 cycles)" wording.
- **Aggregate (150/180 cycles)** reads `GET /api/v1/meter/aggregate`, polled once per second
  and only while that tier is selected. The aggregate combines exactly 15
  consecutive basic measurement blocks into 150 cycles at 50 Hz nominal or 180
  at 60 Hz (~3 s nominal). It carries RMS per channel plus the finalized
  line-line, power, phasor, and unbalance attribute catalog. It has no exposed
  mean correction or RMS count, so those diagnostic card fields are omitted
  rather than zero-filled.
  A provenance strip shows the cycle count and nominal frequency, the basic
  block composition, the first..last basic sequence span, the aggregate age,
  the time quality, and an arithmetic-error warning when the aggregation
  saturated. Sparkline history is kept separately for this tier and extends
  only when the aggregate sequence advances.

Before the first aggregate exists the endpoint returns `available: false`; the
dashboard then shows a plain waiting state explaining that 15 consecutive
eligible basic blocks are needed. This is not an acquisition failure and does
not degrade system health.

The viewer-facing Reading workspace is organized as **Overview**, **Power**,
**Phasor & Unbalance**, **Sequence**, **Harmonics**, and **Power Quality**. Overview is an operator
summary of line-line voltage, authoritative total power, operating mode, and
unbalance; raw dotted attribute names are reserved for collapsed Advanced
tables. The first four tabs share one finalized interval context bar for Basic,
150/180-cycle, clock-aligned 10-minute, and 2-hour records. The browser commits
a record only when `record_complete` is true and every attribute
`source_sequence` matches the top-level sequence. A brief incomplete sibling
update retains the last complete record from the same configuration generation;
a generation change clears it immediately. Every visible card, matrix, and
chart therefore changes from one interval view model. The Reading workspace
does not request the 10-minute or two-hour `/live` preview routes and never
substitutes browser request time for unavailable measurement UTC.

**Reading → Power** defaults to the backend's authoritative Total scope and
offers labeled A/B/C/Total controls, summary cards, a phase matrix,
power-factor context, and a signed equal-scale SVG P–Q₁ operating point.
Positive P means import, negative P export, positive Q₁ inductive/lagging, and
negative Q₁ capacitive/leading. The dashed apparent-power envelope is backend
S; the separately displayed `sqrt(P² + Q₁²)` resultant need not match it in
distorted or unbalanced conditions. Totals are never reconstructed from phase
values. The current backend does not supply THD, fundamental P₁/S₁, or
algorithm profile/version, so those items remain explicitly unavailable and no
distortion component or fundamental triangle is invented.

**Reading → Phasor & Unbalance** retains the fundamental phasor diagram and
adds friendly unbalance summaries plus a collapsed exact-quality/provenance
table. Basic, 150/180-cycle, 10-minute, and 2-hour selections remain in a
waiting state until their first complete finalized record exists. Wye mode
labels voltage vectors Va/Vb/Vc against the L-N nominal reference; delta mode
labels them Vab/Vbc/Vca against the L-L nominal reference.

**Reading → Sequence** provides an original operator visualization of the
backend's authoritative positive, negative, and zero sequence RMS magnitudes,
together with its negative- and zero-sequence ratios. It uses labeled magnitude
lanes, shared-scale ratio meters, and plain-language phase-order guidance rather
than copying an external meter screen. The API does not publish sequence
angles, so the browser does not reconstruct a polar sequence plot or infer
angles from phase data. Its star (wye) or delta connection diagram comes from
`metering.measurement_topology`: the setting changes nominal-voltage labels and
zero-sequence interpretation guidance only, never the PL/RPU sequence
calculation. For star, `system_nominal_voltage_v` is line-to-neutral (L-N); for
delta, it is line-to-line (L-L).

The viewer-facing **Reading → Harmonics** tab reads the latest complete M16
family from `GET /api/v1/meter/harmonics`. Its Voltage selection presents Va,
Vb, and Vc together for orders 1–127; Current presents Ia, Ib, Ic, and In. Each
cell contains subgroup magnitude and Va-referenced angle. The spectrum overview
can show one channel per lane or group all selected channels at each harmonic
order. Its Y-axis title follows the magnitude/percentage selection, and hovering
a bar reports that order's magnitude, percentage of H1, and available relative
angle. The page never mixes partial families: it continues to hide the table
until all 42 channel/chunk records agree. The embedded conditioner selects an exact `L/25` conversion
profile for every
supported 1, 2, 4, 8, 16, 32, 64, or 128 kSPS capture rate and always supplies
4,096 samples to the XFFT. Reading-page values use a larger operator type scale;
the combined harmonic chart is approximately 240 px high and individual lanes
approximately 96 px, without reducing labels on narrow layouts. While a new
profile is applying, the page keeps the previous family hidden until grid lock
and all 42 replacement records agree.

**Reading → Power Quality** reads the typed M18 APIs for independent live
flicker Pinst, finalized Pst/Plt, and mains-signalling carrier observations.
The durable catalogue lives under **History → PQ Event catalogue**. Intersecting
sample windows are grouped into one expandable incident row while the child
events retain their canonical UUID detail. Linked capture UUIDs are joined to
waveform sessions so master and continuation identity remains visible;
completed segments open the shared waveform viewer in place or offer an
event-specific MNCWF export. Administrators can select one or several events
for confirmed deletion without deleting the shared MNCWF files. The browser
does not read DMA, RPMsg, or raw storage.

The aggregate grid frequency is **informative only**. Per
IEC 61000-4-30:2025 the standardized frequency product is defined over its own
10 s interval, which is not this tier, so the aggregate frequency card is
labelled informative and is never presented as a Class A frequency
measurement. Meter controls are separated under the administrator-only
**Configuration → Meter** view, including the grid-frequency zero-crossing
settings, the declared nominal grid frequency selector (50 Hz or 60 Hz),
which chooses the IEC 61000-4-30 basic measurement block of 10 or 12 cycles,
the presentation-only star (wye) or delta measurement connection, the matching
L-N or L-L nominal-voltage reference, and the generator signal frequency that
drives the ADC simulator source.

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

The top-level **Waveforms** page triggers and lists manual captures only;
PQ-only evidence remains in the event catalogue even though both paths share
the same MNCWF-v4 storage and viewer. The viewer can render separate channel
lanes, shared-scale voltage and current overlays, or one normalized all-channel
overlay. The browser sends only the trigger request; the acquisition daemon
owns the dedicated waveform DMA, history, time correlation, and file
materialization.

**Configuration → Power Quality** edits complete event, flicker, and
mains-signalling policy through the central settings authority. It also stores
neutral station, site, circuit, device, and calibration identity in the MNCWF
capture settings for later COMTRADE and PQDIF conversion. The form reloads the
active document immediately before saving so unrelated settings are preserved.

**Configuration → Data Logging** is a read-only health summary. Storage
backend, retention, and maximum-size controls are restricted to
**Developer → Database**. The administrator-only top-level **Management** page
owns destructive actions: clearing historian projections while retaining the
raw spool, clearing the PQ event catalogue while retaining MNCWF files, and
clearing waveform files while retaining event rows. Every action has a scoped
confirmation dialog.

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
npm test
npm run build
```

For development, run `npm run dev`. Vite proxies `/api` to
`http://localhost:8080`. The target build is installed under
`/usr/share/msap1-web` and served by nginx.

The initial development login is `admin` / `admin`. Replace this temporary
authentication provider before production deployment.
