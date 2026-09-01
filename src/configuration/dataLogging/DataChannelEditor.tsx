import { useState } from 'react'
import {
  api, ApiError, DataChannelAuthentication, DataChannelMaterialStatus,
  DataChannelProtocol, DataChannelSettings, DataChannelStatus,
} from '../../api'

const AUTHENTICATION: Record<DataChannelProtocol, { value: DataChannelAuthentication; label: string }[]> = {
  http: [{ value: 'none', label: 'None' }, { value: 'basic', label: 'Basic username/password' },
    { value: 'bearer', label: 'Bearer token' }],
  https: [{ value: 'none', label: 'None' }, { value: 'basic', label: 'Basic username/password' },
    { value: 'bearer', label: 'Bearer token' }, { value: 'mtls', label: 'Mutual TLS' }],
  ftp: [{ value: 'password', label: 'Username/password' }],
  sftp: [{ value: 'password', label: 'Username/password' },
    { value: 'private_key', label: 'Private key' }],
}

const MATERIAL_LABEL: Record<string, string> = {
  ca: 'Trusted CA certificate', 'client-certificate': 'Client certificate',
  'client-key': 'Client private key', 'sftp-private-key': 'SFTP private key',
  'known-hosts': 'Pinned SFTP known-host key',
}

function endpoint(channel: DataChannelSettings) {
  const port = channel.port ? `:${channel.port}` : ''
  const path = channel.protocol === 'http' || channel.protocol === 'https'
    ? channel.http_path : channel.remote_directory
  return `${channel.protocol}://${channel.host || 'host'}${port}${path}`
}

export function DataChannelEditor({ channel, material, runtime, saved, disabled,
  onChange, onRemove, onMaterial, onUnauthorized }: {
  channel: DataChannelSettings
  material?: DataChannelMaterialStatus
  runtime?: DataChannelStatus
  saved: boolean
  disabled: boolean
  onChange: (next: DataChannelSettings) => void
  onRemove: () => void
  onMaterial: (next: DataChannelMaterialStatus) => void
  onUnauthorized: () => void
}) {
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const secure = channel.protocol === 'https'
  const insecure = channel.protocol === 'http' || channel.protocol === 'ftp'
  const secretKind = channel.authentication === 'bearer' ? 'bearer-token'
    : channel.authentication === 'private_key' || channel.authentication === 'mtls'
      ? 'private-key-passphrase' : channel.authentication === 'basic' ||
        channel.authentication === 'password' ? 'password' : undefined
  const secretConfigured = secretKind === 'bearer-token' ? material?.bearer_token_configured
    : secretKind === 'private-key-passphrase' ? material?.private_key_passphrase_configured
      : secretKind === 'password' ? material?.password_configured : false
  const assets: { kind: string; configured: boolean }[] = []
  if (secure && channel.use_uploaded_ca)
    assets.push({ kind: 'ca', configured: material?.ca_configured ?? false })
  if (secure && channel.use_client_certificate) {
    assets.push({ kind: 'client-certificate', configured: material?.client_certificate_configured ?? false })
    assets.push({ kind: 'client-key', configured: material?.client_key_configured ?? false })
  }
  if (channel.protocol === 'sftp') {
    assets.push({ kind: 'known-hosts', configured: material?.known_hosts_configured ?? false })
    if (channel.authentication === 'private_key')
      assets.push({ kind: 'sftp-private-key', configured: material?.sftp_private_key_configured ?? false })
  }

  function fail(reason: unknown, fallback: string) {
    if (reason instanceof ApiError && reason.status === 401) onUnauthorized()
    else setError(reason instanceof Error ? reason.message : fallback)
  }

  async function updateSecret(remove = false) {
    if (!secretKind) return
    setBusy(true); setError(''); setMessage('')
    try {
      const next = remove
        ? await api.deleteDataChannelCredential(channel.id, secretKind)
        : await api.setDataChannelCredential(channel.id, secretKind, secret)
      setSecret(''); onMaterial(next)
      setMessage(remove ? 'Credential removed.' : 'Credential replaced securely.')
    } catch (reason) { fail(reason, 'Unable to update credential') }
    finally { setBusy(false) }
  }

  async function upload(kind: string, file: File) {
    setBusy(true); setError(''); setMessage('')
    try {
      onMaterial(await api.uploadDataChannelAsset(channel.id, kind, file))
      setMessage(`${MATERIAL_LABEL[kind]} uploaded.`)
    } catch (reason) { fail(reason, 'Unable to upload channel asset') }
    finally { setBusy(false) }
  }

  async function removeAsset(kind: string) {
    setBusy(true); setError(''); setMessage('')
    try {
      onMaterial(await api.deleteDataChannelAsset(channel.id, kind))
      setMessage(`${MATERIAL_LABEL[kind]} removed.`)
    } catch (reason) { fail(reason, 'Unable to remove channel asset') }
    finally { setBusy(false) }
  }

  async function test() {
    setBusy(true); setError(''); setMessage('Sending a zero-data probe…')
    try {
      const result = await api.testDataChannel(channel.id)
      setMessage(`Test ${result.state}${result.message ? `: ${result.message}` : '.'}`)
    } catch (reason) { setMessage(''); fail(reason, 'Channel test failed') }
    finally { setBusy(false) }
  }

  function protocol(protocol: DataChannelProtocol) {
    const authentication = AUTHENTICATION[protocol][0].value
    onChange({ ...channel, protocol, authentication,
      use_system_ca: true, use_uploaded_ca: false,
      use_client_certificate: authentication === 'mtls',
      insecure_transport_acknowledged: false })
  }

  return <article className="data-channel-card">
    <header><div><strong>{channel.name || 'Unnamed channel'}</strong>
      <span>{endpoint(channel)}</span></div>
      <div><span className={runtime?.ready ? 'ready' : 'attention'}>
        {runtime ? runtime.ready ? 'Ready' : 'Needs attention' : saved ? 'Status pending' : 'Unsaved'}
      </span><button type="button" className="secondary" disabled={disabled || busy}
        onClick={onRemove}>Remove</button></div></header>
    {runtime?.readiness_error && <p className="data-channel-error">{runtime.readiness_error}</p>}
    {insecure && <div className="data-channel-warning" role="alert"><strong>Unencrypted transport</strong>
      <span>Credentials and meter data can be read or changed on the network. Use only on a trusted network.</span></div>}
    <div className="data-channel-fields">
      <label>Channel name<input value={channel.name} disabled={disabled}
        onChange={(event) => onChange({ ...channel, name: event.target.value })} /></label>
      <label>Protocol<select value={channel.protocol} disabled={disabled}
        onChange={(event) => protocol(event.target.value as DataChannelProtocol)}>
        <option value="https">HTTPS</option><option value="sftp">SFTP</option>
        <option value="http">HTTP (insecure)</option><option value="ftp">FTP (insecure)</option>
      </select></label>
      <label>Hostname or IP<input value={channel.host} disabled={disabled}
        onChange={(event) => onChange({ ...channel, host: event.target.value })} /></label>
      <label>Port <small>0 uses the protocol default</small><input type="number" min="0" max="65535"
        value={channel.port} disabled={disabled}
        onChange={(event) => onChange({ ...channel, port: Number(event.target.value) })} /></label>
      {(channel.protocol === 'http' || channel.protocol === 'https')
        ? <label>POST path<input value={channel.http_path} disabled={disabled}
          onChange={(event) => onChange({ ...channel, http_path: event.target.value })} /></label>
        : <label>Remote directory<input value={channel.remote_directory} disabled={disabled}
          onChange={(event) => onChange({ ...channel, remote_directory: event.target.value })} /></label>}
      <label>Authentication<select value={channel.authentication} disabled={disabled}
        onChange={(event) => {
          const authentication = event.target.value as DataChannelAuthentication
          onChange({ ...channel, authentication,
            use_client_certificate: authentication === 'mtls' })
        }}>{AUTHENTICATION[channel.protocol].map((option) =>
          <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      {channel.authentication !== 'none' && channel.authentication !== 'bearer' &&
        channel.authentication !== 'mtls' && <label>Username<input value={channel.username}
          autoComplete="username" disabled={disabled}
          onChange={(event) => onChange({ ...channel, username: event.target.value })} /></label>}
      <label>Connect timeout (seconds)<input type="number" min="1" max="300"
        value={channel.connect_timeout_seconds} disabled={disabled}
        onChange={(event) => onChange({ ...channel, connect_timeout_seconds: Number(event.target.value) })} /></label>
      <label>Transfer timeout (seconds)<input type="number" min="1" max="3600"
        value={channel.transfer_timeout_seconds} disabled={disabled}
        onChange={(event) => onChange({ ...channel, transfer_timeout_seconds: Number(event.target.value) })} /></label>
    </div>
    <div className="data-channel-toggles">
      <label><input type="checkbox" checked={channel.enabled} disabled={disabled}
        onChange={(event) => onChange({ ...channel, enabled: event.target.checked })} />Enabled</label>
      {secure && <label><input type="radio" name={`ca-${channel.id}`} checked={channel.use_system_ca}
        disabled={disabled} onChange={() => onChange({ ...channel, use_system_ca: true, use_uploaded_ca: false })} />Use system CA certificates</label>}
      {secure && <label><input type="radio" name={`ca-${channel.id}`} checked={channel.use_uploaded_ca}
        disabled={disabled} onChange={() => onChange({ ...channel, use_system_ca: false, use_uploaded_ca: true })} />Use uploaded CA certificate</label>}
      {insecure && <label className="danger-choice"><input type="checkbox"
        checked={channel.insecure_transport_acknowledged} disabled={disabled}
        onChange={(event) => onChange({ ...channel, insecure_transport_acknowledged: event.target.checked })} />I understand this channel is unencrypted</label>}
    </div>
    {saved && secretKind && <section className="data-channel-material"><h4>Protected credential</h4>
      <label>{secretKind.replaceAll('-', ' ')}<input type="password" autoComplete="new-password"
        value={secret} placeholder={secretConfigured ? 'Configured — leave blank to keep' : 'Not configured'}
        disabled={disabled || busy} onChange={(event) => setSecret(event.target.value)} /></label>
      <button type="button" disabled={disabled || busy || !secret}
        onClick={() => void updateSecret(false)}>Replace securely</button>
      <button type="button" className="secondary" disabled={disabled || busy || !secretConfigured}
        onClick={() => void updateSecret(true)}>Remove</button>
    </section>}
    {saved && assets.map(({ kind, configured }) => <section className="data-channel-material" key={kind}>
      <div><strong>{MATERIAL_LABEL[kind]}</strong><span>{configured ? 'Configured' : 'Required'}</span></div>
      <label className="file-button">Upload<input type="file" disabled={disabled || busy}
        accept={kind === 'known-hosts' ? '.txt,text/plain' : '.pem,.crt,.cer,.key,application/x-pem-file'}
        onChange={(event) => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void upload(kind, file) }} /></label>
      <button type="button" className="secondary" disabled={disabled || busy || !configured}
        onClick={() => void removeAsset(kind)}>Remove</button>
    </section>)}
    {!saved && <p className="data-channel-note">Save the channel before adding protected credentials or verification files.</p>}
    {error && <p className="data-channel-error" role="alert">{error}</p>}
    {message && <p className="data-channel-message" role="status">{message}</p>}
    <footer><button type="button" className="secondary" disabled={disabled || busy || !saved}
      onClick={() => void test()}>Test saved channel</button>
      <span>A test sends a clearly marked zero-data probe. Saving never connects.</span></footer>
  </article>
}
