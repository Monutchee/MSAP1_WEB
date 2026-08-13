import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api, ApiError, mqttCaDownloadPath, mqttClientCertificateDownloadPath,
  MqttConfigurationDocument, MqttCredentialStatus, MqttPeriodCapability,
  MqttPublicationSettings, MqttSettings, MqttStatus, MqttTransport,
} from '../api'
import './mqtt.css'

const DEFAULT_PORT: Record<MqttTransport, number> = {
  mqtt: 1883, mqtts: 8883, ws: 80, wss: 443,
}

function newPublication(index: number, capabilities: MqttPeriodCapability[]): MqttPublicationSettings {
  const period = capabilities[0]?.id ?? 'basic'
  return {
    id: `publication-${index}`,
    enabled: true,
    topic: `msap1/meter/${index}`,
    period,
    interval_ms: 1000,
    qos: 1,
    retain: false,
    attributes: capabilities.find((entry) => entry.id === period)?.attributes
      .slice(0, 1).map((entry) => entry.id) ?? [],
  }
}

function CredentialAsset({ label, configured, downloadable, downloadPath, onUpload,
  onDelete, disabled }: {
  label: string
  configured: boolean
  downloadable: boolean
  downloadPath?: string
  onUpload: (file: File) => Promise<void>
  onDelete: () => Promise<void>
  disabled: boolean
}) {
  return <div className="mqtt-asset">
    <div><strong>{label}</strong><span>{configured ? 'Configured' : 'Not configured'}</span></div>
    <label className="file-button">Upload<input type="file" accept=".pem,.crt,.cer,.key,application/x-pem-file"
      disabled={disabled} onChange={(event) => {
        const file = event.target.files?.[0]
        event.currentTarget.value = ''
        if (file) void onUpload(file)
      }} /></label>
    {downloadable && configured && downloadPath && <a className="secondary button-link"
	  href={downloadPath} download>Download</a>}
    <button className="secondary" type="button" disabled={disabled || !configured}
      onClick={() => void onDelete()}>Delete</button>
  </div>
}

/** Administrator MQTT policy editor backed by the central settings authority. */
export function MqttConfiguration({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [document, setDocument] = useState<MqttConfigurationDocument>()
  const [capabilities, setCapabilities] = useState<MqttPeriodCapability[]>([])
  const [runtime, setRuntime] = useState<MqttStatus>()
  const [configurationLoading, setConfigurationLoading] = useState(true)
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(true)
  const [runtimeLoading, setRuntimeLoading] = useState(true)
  const [password, setPassword] = useState('')
  const [keyPassphrase, setKeyPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [capabilitiesError, setCapabilitiesError] = useState('')
  const [runtimeError, setRuntimeError] = useState('')
  const runtimeRequestInFlight = useRef(false)

  const handleError = useCallback((reason: unknown, fallback: string) => {
    if (reason instanceof ApiError && reason.status === 401) {
      onUnauthorized()
      return
    }
    setError(reason instanceof Error ? reason.message : fallback)
  }, [onUnauthorized])

  const loadConfiguration = useCallback(async () => {
    setConfigurationLoading(true)
    try {
      setDocument(await api.mqttConfiguration())
      setError('')
    } catch (reason) {
      handleError(reason, 'Unable to read MQTT configuration')
    } finally {
      setConfigurationLoading(false)
    }
  }, [handleError])

  const loadCapabilities = useCallback(async () => {
    setCapabilitiesLoading(true)
    try {
      setCapabilities(await api.mqttCapabilities())
      setCapabilitiesError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onUnauthorized()
      else setCapabilitiesError(reason instanceof Error
        ? reason.message : 'Unable to read MQTT capabilities')
    } finally {
      setCapabilitiesLoading(false)
    }
  }, [onUnauthorized])

  const loadRuntime = useCallback(async (showLoading: boolean) => {
    if (runtimeRequestInFlight.current) return
    runtimeRequestInFlight.current = true
    if (showLoading) setRuntimeLoading(true)
    try {
      setRuntime(await api.mqttStatus())
      setRuntimeError('')
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onUnauthorized()
      else setRuntimeError(reason instanceof Error
        ? reason.message : 'Unable to read MQTT runtime status')
    } finally {
      runtimeRequestInFlight.current = false
      if (showLoading) setRuntimeLoading(false)
    }
  }, [onUnauthorized])

  useEffect(() => {
    void loadConfiguration()
    void loadCapabilities()
    void loadRuntime(true)
  }, [loadCapabilities, loadConfiguration, loadRuntime])
  useEffect(() => {
    const timer = window.setInterval(() => void loadRuntime(false), 3000)
    return () => window.clearInterval(timer)
  }, [loadRuntime])

  const secureTransport = document?.settings.connection.transport === 'mqtts' ||
    document?.settings.connection.transport === 'wss'
  const websocketTransport = document?.settings.connection.transport === 'ws' ||
    document?.settings.connection.transport === 'wss'

  const capabilityByPeriod = useMemo(() => new Map(
    capabilities.map((entry) => [entry.id, entry])), [capabilities])

  function edit(editSettings: (settings: MqttSettings) => MqttSettings) {
    setDocument((current) => current
      ? { ...current, settings: editSettings(current.settings) } : current)
  }

  function editPublication(index: number, update: Partial<MqttPublicationSettings>) {
    edit((settings) => ({
      ...settings,
      publications: settings.publications.map((publication, item) =>
        item === index ? { ...publication, ...update } : publication),
    }))
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!document) return
    setBusy(true); setError(''); setMessage('Applying MQTT settings…')
    try {
      let credentials = document.credentials
      if (password) {
        credentials = await api.setMqttPassword(password)
        setPassword('')
      }
      if (keyPassphrase) {
        credentials = await api.setMqttPrivateKeyPassphrase(keyPassphrase)
        setKeyPassphrase('')
      }
      const saved = await api.updateMqttConfiguration(document.settings)
      setDocument({ ...saved, credentials })
      setMessage(saved.settings.enabled
        ? 'Saved. The MQTT publisher is applying the configuration.'
        : 'Saved. MQTT publishing is disabled.')
      window.setTimeout(() => void loadRuntime(false), 1000)
    } catch (reason) {
      setMessage(''); handleError(reason, 'Unable to save MQTT settings')
    } finally { setBusy(false) }
  }

  async function credentialAction(action: () => Promise<MqttCredentialStatus>, success: string) {
    setBusy(true); setError('')
    try {
      const credentials = await action()
      setDocument((current) => current ? { ...current, credentials } : current)
      setMessage(success)
    } catch (reason) {
      handleError(reason, 'Unable to update MQTT credential')
    } finally { setBusy(false) }
  }

  return <div className="mqtt-configuration">
    <section className="section-heading configuration-heading">
      <div><p className="eyebrow">Publisher</p><h2>MQTT</h2></div>
      <span className={`mqtt-state ${runtime?.state ?? 'unavailable'}`}>
        {runtime?.state ?? (runtimeLoading ? 'Loading…' : 'Unavailable')}
      </span>
    </section>
    {error && <div className="error-banner"><strong>MQTT unavailable</strong><span>{error}</span></div>}
    {runtimeError && <div className="mqtt-status-warning"><strong>Runtime status unavailable</strong>
      <span>{runtimeError}</span></div>}
    <section className="mqtt-runtime" aria-busy={runtimeLoading}>
      <strong>Runtime</strong>
      <span>State: {runtime?.state ?? (runtimeLoading ? 'loading' : 'unavailable')}</span>
      <span>Broker: {runtime?.server_uri || 'not connected'}</span>
      <span>Published: {runtime?.successful_publishes ?? 0}</span>
      {(runtime?.last_successful_publish_unix_ms ?? 0) > 0 &&
        <span>Last publish: {new Date(runtime!.last_successful_publish_unix_ms).toLocaleString()}</span>}
      {runtime?.last_error && <span className="bad">Last error: {runtime.last_error}</span>}
    </section>
    {!document && configurationLoading && <div className="database-progress">Loading MQTT settings…</div>}
    {document && <form className="mqtt-form" onSubmit={save}>
      <fieldset><legend>Service and broker</legend>
        <div className="mqtt-fields">
          <label className="toggle"><input type="checkbox" checked={document.settings.enabled}
            onChange={(event) => edit((settings) => ({ ...settings, enabled: event.target.checked }))} />
            Enable MQTT publishing</label>
          <label>Transport<select value={document.settings.connection.transport}
            onChange={(event) => {
              const transport = event.target.value as MqttTransport
              edit((settings) => ({ ...settings, connection: {
                ...settings.connection, transport, broker_port: DEFAULT_PORT[transport],
              } }))
            }}><option value="mqtt">MQTT (TCP)</option><option value="mqtts">MQTTS (TLS)</option>
            <option value="ws">MQTT over WebSocket</option><option value="wss">Secure WebSocket</option>
          </select></label>
          <label>Broker hostname or IP<input value={document.settings.connection.broker_host}
            onChange={(event) => edit((settings) => ({ ...settings, connection: {
              ...settings.connection, broker_host: event.target.value,
            } }))} required={document.settings.enabled} /></label>
          <label>Port<input type="number" min="1" max="65535"
            value={document.settings.connection.broker_port}
            onChange={(event) => edit((settings) => ({ ...settings, connection: {
              ...settings.connection, broker_port: Number(event.target.value),
            } }))} /></label>
          {websocketTransport && <label>WebSocket path<input
            value={document.settings.connection.websocket_path}
            onChange={(event) => edit((settings) => ({ ...settings, connection: {
              ...settings.connection, websocket_path: event.target.value,
            } }))} /></label>}
          <label>Client ID<input value={document.settings.connection.client_id}
            onChange={(event) => edit((settings) => ({ ...settings, connection: {
              ...settings.connection, client_id: event.target.value,
            } }))} /></label>
          <label>Username<input autoComplete="username" value={document.settings.connection.username}
            onChange={(event) => edit((settings) => ({ ...settings, connection: {
              ...settings.connection, username: event.target.value,
            } }))} /></label>
          <label>Password<input type="password" autoComplete="new-password" value={password}
            placeholder={document.credentials.password_configured ? 'Configured — leave blank to keep' : 'Optional'}
            onChange={(event) => setPassword(event.target.value)} /></label>
          <label>Keepalive (seconds)<input type="number" min="1" max="65535"
            value={document.settings.connection.keep_alive_seconds}
            onChange={(event) => edit((settings) => ({ ...settings, connection: {
              ...settings.connection, keep_alive_seconds: Number(event.target.value),
            } }))} /></label>
          <label>Connect timeout (seconds)<input type="number" min="1" max="300"
            value={document.settings.connection.connect_timeout_seconds}
            onChange={(event) => edit((settings) => ({ ...settings, connection: {
              ...settings.connection, connect_timeout_seconds: Number(event.target.value),
            } }))} /></label>
          <label>Reconnect minimum (seconds)<input type="number" min="1" max="3600"
            value={document.settings.connection.reconnect_min_seconds}
            onChange={(event) => edit((settings) => ({ ...settings, connection: {
              ...settings.connection, reconnect_min_seconds: Number(event.target.value),
            } }))} /></label>
          <label>Reconnect maximum (seconds)<input type="number" min="1" max="86400"
            value={document.settings.connection.reconnect_max_seconds}
            onChange={(event) => edit((settings) => ({ ...settings, connection: {
              ...settings.connection, reconnect_max_seconds: Number(event.target.value),
            } }))} /></label>
        </div>
        {document.credentials.password_configured && <button className="secondary" type="button"
          disabled={busy} onClick={() => void credentialAction(api.clearMqttPassword, 'MQTT password removed.')}>Clear password</button>}
      </fieldset>

      {secureTransport && <fieldset><legend>TLS</legend>
        <div className="mqtt-toggles">
          <label className="toggle"><input type="checkbox" checked={document.settings.tls.use_system_ca}
            onChange={(event) => edit((settings) => ({ ...settings, tls: {
              ...settings.tls, use_system_ca: event.target.checked,
            } }))} />Use system CA bundle</label>
          <label className="toggle"><input type="checkbox" checked={document.settings.tls.verify_peer}
            onChange={(event) => edit((settings) => ({ ...settings, tls: {
              ...settings.tls, verify_peer: event.target.checked,
            } }))} />Verify broker certificate</label>
          <label className="toggle"><input type="checkbox" checked={document.settings.tls.verify_hostname}
            onChange={(event) => edit((settings) => ({ ...settings, tls: {
              ...settings.tls, verify_hostname: event.target.checked,
            } }))} />Verify broker hostname</label>
          <label className="toggle"><input type="checkbox" checked={document.settings.tls.use_client_certificate}
            onChange={(event) => edit((settings) => ({ ...settings, tls: {
              ...settings.tls, use_client_certificate: event.target.checked,
            } }))} />Use mutual TLS</label>
        </div>
        <div className="mqtt-assets">
          <CredentialAsset label="CA certificate" configured={document.credentials.ca_configured}
            downloadable downloadPath={mqttCaDownloadPath} disabled={busy}
            onUpload={(file) => credentialAction(() => api.uploadMqttCa(file), 'CA certificate uploaded.')}
            onDelete={() => credentialAction(api.deleteMqttCa, 'CA certificate removed.')} />
          <CredentialAsset label="Client certificate" configured={document.credentials.client_certificate_configured}
            downloadable downloadPath={mqttClientCertificateDownloadPath} disabled={busy}
            onUpload={(file) => credentialAction(() => api.uploadMqttClientCertificate(file), 'Client certificate uploaded.')}
            onDelete={() => credentialAction(api.deleteMqttClientCertificate, 'Client certificate removed.')} />
          <CredentialAsset label="Client private key" configured={document.credentials.client_key_configured}
            downloadable={false} disabled={busy}
            onUpload={(file) => credentialAction(() => api.uploadMqttClientKey(file), 'Private key uploaded.')}
            onDelete={() => credentialAction(api.deleteMqttClientKey, 'Private key removed.')} />
        </div>
        <div className="mqtt-passphrase"><label>Private-key passphrase<input type="password"
          autoComplete="new-password" value={keyPassphrase}
          placeholder={document.credentials.private_key_passphrase_configured
            ? 'Configured — leave blank to keep' : 'Only for encrypted keys'}
          onChange={(event) => setKeyPassphrase(event.target.value)} /></label>
          {document.credentials.private_key_passphrase_configured && <button className="secondary" type="button"
            onClick={() => void credentialAction(api.clearMqttPrivateKeyPassphrase, 'Private-key passphrase removed.')}>Clear passphrase</button>}
        </div>
        <p className="mqtt-warning">Private keys are upload-only and can never be downloaded.</p>
      </fieldset>}

      <fieldset><legend>Publications</legend>
        <p className="mqtt-help">Each topic independently reads the newest coherent meter snapshot. New catalog attributes appear here without changing saved selections.</p>
        {capabilitiesLoading && <div className="database-progress">Loading meter attribute catalog…</div>}
        {capabilitiesError && <div className="mqtt-status-warning"><strong>Attribute catalog unavailable</strong>
          <span>{capabilitiesError}</span></div>}
        {!capabilitiesLoading && !capabilitiesError && <div className="mqtt-publications">
          {document.settings.publications.map((publication, index) => {
            const available = capabilityByPeriod.get(publication.period)?.attributes ?? []
            return <article key={`${publication.id}-${index}`}>
              <header><strong>{publication.id || `Publication ${index + 1}`}</strong>
                <button className="secondary" type="button" onClick={() => edit((settings) => ({
                  ...settings, publications: settings.publications.filter((_, item) => item !== index),
                }))}>Remove</button></header>
              <div className="mqtt-fields">
                <label className="toggle"><input type="checkbox" checked={publication.enabled}
                  onChange={(event) => editPublication(index, { enabled: event.target.checked })} />Enabled</label>
                <label>Publication ID<input value={publication.id}
                  onChange={(event) => editPublication(index, { id: event.target.value })} /></label>
                <label>Topic<input value={publication.topic}
                  onChange={(event) => editPublication(index, { topic: event.target.value })} /></label>
                <label>Measurement period<select value={publication.period}
                  onChange={(event) => editPublication(index, {
                    period: event.target.value, attributes: [],
                  })}>{capabilities.map((period) => <option key={period.id} value={period.id}>{period.id}</option>)}</select></label>
                <label>Interval (ms)<input type="number" min="100" max="86400000"
                  value={publication.interval_ms}
                  onChange={(event) => editPublication(index, { interval_ms: Number(event.target.value) })} /></label>
                <label>QoS<select value={publication.qos}
                  onChange={(event) => editPublication(index, { qos: Number(event.target.value) as 0 | 1 | 2 })}>
                  <option value={0}>0 — at most once</option><option value={1}>1 — at least once</option>
                  <option value={2}>2 — exactly once</option></select></label>
                <label className="toggle"><input type="checkbox" checked={publication.retain}
                  onChange={(event) => editPublication(index, { retain: event.target.checked })} />Retain latest payload</label>
              </div>
              <fieldset className="mqtt-attributes"><legend>Meter attributes</legend>
                {available.length === 0 && <span>No attributes are currently available for this period.</span>}
                {available.map((attribute) => <label key={attribute.id} className="toggle">
                  <input type="checkbox" checked={publication.attributes.includes(attribute.id)}
                    onChange={(event) => editPublication(index, {
                      attributes: event.target.checked
                        ? [...publication.attributes, attribute.id]
                        : publication.attributes.filter((value) => value !== attribute.id),
                    })} />{attribute.id} <small>({attribute.unit})</small></label>)}
              </fieldset>
              {runtime?.publications[publication.id] && <p className="mqtt-statistics">
                Attempts {runtime.publications[publication.id].attempts ?? 0} · successful {runtime.publications[publication.id].successes ?? 0} · failures {runtime.publications[publication.id].failures ?? 0}
				{runtime.publications[publication.id].last_successful_publish_unix_ms > 0 &&
				  <> · last {new Date(runtime.publications[publication.id].last_successful_publish_unix_ms).toLocaleString()}</>}
              </p>}
            </article>
          })}
        </div>}
        <button className="secondary" type="button"
          disabled={capabilitiesLoading || Boolean(capabilitiesError)}
          onClick={() => edit((settings) => ({
          ...settings,
          publications: [...settings.publications,
            newPublication(settings.publications.length + 1, capabilities)],
        }))}>Add publication</button>
      </fieldset>

      <div className="mqtt-actions"><button type="submit" disabled={busy}>
        {busy ? 'Applying…' : 'Apply and save'}</button><span>{message}</span></div>
    </form>}
  </div>
}
