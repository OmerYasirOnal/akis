import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  validHost, validSshUser, validTargetDir, validAppPort, validPublicUrl, looksLikePem,
  isInternalPublishHost, allowInternalPublishTarget, isUrlSafeToProbe,
} from '../../src/publish/validate.js'

describe('publish validators (security boundary for argv-bound Settings input)', () => {
  it('validHost accepts plain hosts + IP literals, REJECTS option-injection + metachars', () => {
    expect(validHost('oci.example.com')).toBe(true)
    expect(validHost('132.226.10.5')).toBe(true)
    // The live OCI publish target is PUBLIC and must keep validating fine (regression pin).
    expect(validHost('141.147.25.123')).toBe(true)
    expect(validHost('[2001:db8::1]')).toBe(true)
    // The OpenSSH option-injection vector: a leading '-' "host" becomes an ssh OPTION.
    expect(validHost('-oProxyCommand=touch /tmp/pwned')).toBe(false)
    expect(validHost('-lroot')).toBe(false)
    expect(validHost('host;rm -rf ~')).toBe(false)
    expect(validHost('$(whoami)')).toBe(false)
    expect(validHost('`id`')).toBe(false)
    expect(validHost('host\nname')).toBe(false)
    expect(validHost('a..b')).toBe(false)
    expect(validHost('-')).toBe(false)
    expect(validHost('')).toBe(false)
    expect(validHost(123 as unknown)).toBe(false)
  })

  it('validSshUser accepts POSIX login names, REJECTS a leading dash + metachars', () => {
    expect(validSshUser('ubuntu')).toBe(true)
    expect(validSshUser('opc')).toBe(true)
    expect(validSshUser('_svc-acct')).toBe(true)
    expect(validSshUser('-oProxyCommand=x')).toBe(false)
    expect(validSshUser('root;id')).toBe(false)
    expect(validSshUser('Ubuntu')).toBe(false) // POSIX login names are lowercase-leading
    expect(validSshUser('')).toBe(false)
  })

  it('validTargetDir accepts absolute POSIX paths, REJECTS .., metachars, quotes, newlines', () => {
    expect(validTargetDir('/home/ubuntu/app')).toBe(true)
    expect(validTargetDir('/opt/akis-app_1')).toBe(true)
    expect(validTargetDir('relative/path')).toBe(false)
    expect(validTargetDir('/home/../etc/passwd')).toBe(false)
    expect(validTargetDir('/home/ubuntu/$(rm -rf ~)')).toBe(false)
    expect(validTargetDir('/home/`id`')).toBe(false)
    expect(validTargetDir('/home/app;reboot')).toBe(false)
    expect(validTargetDir('/home/app && curl evil')).toBe(false)
    expect(validTargetDir('/home/app|nc')).toBe(false)
    expect(validTargetDir('/home/"app"')).toBe(false)
    expect(validTargetDir('/home/app\nrm')).toBe(false)
    expect(validTargetDir('')).toBe(false)
  })

  it('validAppPort accepts 1025..65535, REJECTS ≤1024 + non-integers', () => {
    expect(validAppPort(8080)).toBe(true)
    expect(validAppPort(1025)).toBe(true)
    expect(validAppPort(65535)).toBe(true)
    expect(validAppPort(80)).toBe(false) // a non-root login user cannot bind ≤1024
    expect(validAppPort(1024)).toBe(false)
    expect(validAppPort(0)).toBe(false)
    expect(validAppPort(70000)).toBe(false)
    expect(validAppPort(8080.5)).toBe(false)
    expect(validAppPort('8080' as unknown)).toBe(false)
  })

  it('validPublicUrl accepts http/https, REJECTS other schemes + garbage', () => {
    expect(validPublicUrl('http://oci.example.com:8080')).toBe(true)
    expect(validPublicUrl('https://app.example.com')).toBe(true)
    // The live OCI publish target is PUBLIC and must keep validating fine (regression pin).
    expect(validPublicUrl('http://141.147.25.123:8080')).toBe(true)
    expect(validPublicUrl('javascript:alert(1)')).toBe(false)
    expect(validPublicUrl('file:///etc/passwd')).toBe(false)
    expect(validPublicUrl('not a url')).toBe(false)
    expect(validPublicUrl('')).toBe(false)
  })

  it('looksLikePem accepts a PEM private-key block, REJECTS arbitrary text', () => {
    expect(looksLikePem('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----')).toBe(true)
    expect(looksLikePem('-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----')).toBe(true)
    expect(looksLikePem('just a string')).toBe(false)
    expect(looksLikePem('-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----')).toBe(false)
    expect(looksLikePem('')).toBe(false)
  })
})

describe('publish SSRF guard (internal-address blocklist on host + publicUrl)', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('isInternalPublishHost flags loopback, metadata, link-local, RFC1918 + internal hostnames', () => {
    // Loopback (v4 + v6) and unspecified.
    expect(isInternalPublishHost('127.0.0.1')).toBe(true)
    expect(isInternalPublishHost('127.1.2.3')).toBe(true) // all of 127/8
    expect(isInternalPublishHost('[::1]')).toBe(true)
    expect(isInternalPublishHost('::1')).toBe(true)
    expect(isInternalPublishHost('0.0.0.0')).toBe(true)
    // Cloud metadata + link-local (169.254/16, fe80::/10).
    expect(isInternalPublishHost('169.254.169.254')).toBe(true)
    expect(isInternalPublishHost('169.254.1.1')).toBe(true)
    expect(isInternalPublishHost('fe80::1')).toBe(true)
    // RFC1918.
    expect(isInternalPublishHost('10.0.0.5')).toBe(true)
    expect(isInternalPublishHost('192.168.1.10')).toBe(true)
    expect(isInternalPublishHost('172.16.0.1')).toBe(true)
    expect(isInternalPublishHost('172.31.255.255')).toBe(true)
    // Unique-local IPv6 + IPv4-mapped IPv6 (must classify by the embedded v4).
    expect(isInternalPublishHost('fd00::1')).toBe(true)
    expect(isInternalPublishHost('::ffff:169.254.169.254')).toBe(true)
    expect(isInternalPublishHost('::ffff:127.0.0.1')).toBe(true)
    // Obvious internal hostnames.
    expect(isInternalPublishHost('localhost')).toBe(true)
    expect(isInternalPublishHost('metadata.google.internal')).toBe(true)
    expect(isInternalPublishHost('db.svc.internal')).toBe(true)
    expect(isInternalPublishHost('printer.local')).toBe(true)
    // PUBLIC addresses are NOT internal — the live OCI target + 172.32 (just outside RFC1918).
    expect(isInternalPublishHost('141.147.25.123')).toBe(false)
    expect(isInternalPublishHost('8.8.8.8')).toBe(false)
    expect(isInternalPublishHost('172.32.0.1')).toBe(false)
    expect(isInternalPublishHost('oci.example.com')).toBe(false)
    expect(isInternalPublishHost('[2001:db8::1]')).toBe(false)
  })

  it('validHost REJECTS internal targets by default (would pass the old shape-only check)', () => {
    // These all pass validHost's syntactic shape check — the OLD code accepted them. They must now
    // be rejected (the SSRF blocklist), proving this test would FAIL on the pre-fix validator.
    expect(validHost('169.254.169.254')).toBe(false)
    expect(validHost('localhost')).toBe(false)
    expect(validHost('127.0.0.1')).toBe(false)
    expect(validHost('10.0.0.5')).toBe(false)
    expect(validHost('192.168.1.10')).toBe(false)
    expect(validHost('172.16.0.1')).toBe(false)
    expect(validHost('metadata.google.internal')).toBe(false)
    expect(validHost('[::1]')).toBe(false)
    // The PUBLIC live target still validates fine.
    expect(validHost('141.147.25.123')).toBe(true)
  })

  it('validPublicUrl REJECTS internal hosts by default (was http/https-only before the fix)', () => {
    expect(validPublicUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(validPublicUrl('http://127.0.0.1:9200/_cat/indices')).toBe(false)
    expect(validPublicUrl('http://10.0.0.5:6379/')).toBe(false)
    expect(validPublicUrl('http://localhost:3000')).toBe(false)
    expect(validPublicUrl('http://[::1]:8080')).toBe(false)
    // PUBLIC URLs still validate.
    expect(validPublicUrl('http://141.147.25.123:8080')).toBe(true)
  })

  it('AKIS_PUBLISH_ALLOW_INTERNAL=1 is the documented escape hatch — re-allows internal targets', () => {
    expect(allowInternalPublishTarget({ AKIS_PUBLISH_ALLOW_INTERNAL: '1' })).toBe(true)
    expect(allowInternalPublishTarget({ AKIS_PUBLISH_ALLOW_INTERNAL: '0' })).toBe(false)
    expect(allowInternalPublishTarget({})).toBe(false)
    // With the opt-in set, validHost/validPublicUrl accept a loopback target (single-user story).
    vi.stubEnv('AKIS_PUBLISH_ALLOW_INTERNAL', '1')
    expect(validHost('127.0.0.1')).toBe(true)
    expect(validHost('localhost')).toBe(true)
    expect(validPublicUrl('http://localhost:3000')).toBe(true)
  })
})

describe('isUrlSafeToProbe (DNS-resolving defense-in-depth before the server-side fetch)', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('REJECTS a public-looking hostname that REBINDS to an internal IP (the rebinding case)', async () => {
    // The syntactic validators pass evil.example.com — only resolving it exposes the private IP.
    const rebind = async () => ['169.254.169.254']
    expect(await isUrlSafeToProbe('http://evil.example.com/', rebind)).toBe(false)
    const toLoopback = async () => ['127.0.0.1']
    expect(await isUrlSafeToProbe('http://evil.example.com/', toLoopback)).toBe(false)
    // Multi-A where ANY record is private is unsafe (no first-only bypass).
    const mixed = async () => ['141.147.25.123', '10.0.0.5']
    expect(await isUrlSafeToProbe('http://evil.example.com/', mixed)).toBe(false)
  })

  it('ALLOWS a hostname that resolves only to public IPs (e.g. the OCI target)', async () => {
    const toPublic = async () => ['141.147.25.123']
    expect(await isUrlSafeToProbe('http://oci.example.com:8080/', toPublic)).toBe(true)
  })

  it('rejects an internal IP LITERAL / internal hostname without even resolving (fail-closed)', async () => {
    let resolved = false
    const spy = async () => { resolved = true; return ['8.8.8.8'] }
    expect(await isUrlSafeToProbe('http://169.254.169.254/', spy)).toBe(false)
    expect(await isUrlSafeToProbe('http://localhost:3000/', spy)).toBe(false)
    expect(resolved).toBe(false) // never hit DNS for a known-internal target
    // A DNS failure is fail-closed: do not fetch.
    const fail = async () => { throw new Error('NXDOMAIN') }
    expect(await isUrlSafeToProbe('http://nope.example.com/', fail)).toBe(false)
    // No addresses → do not fetch.
    const none = async () => []
    expect(await isUrlSafeToProbe('http://empty.example.com/', none)).toBe(false)
  })

  it('honors AKIS_PUBLISH_ALLOW_INTERNAL=1 — then any target is probe-safe (single-user/loopback)', async () => {
    vi.stubEnv('AKIS_PUBLISH_ALLOW_INTERNAL', '1')
    const neverCalled = async () => { throw new Error('should not resolve') }
    expect(await isUrlSafeToProbe('http://127.0.0.1:3000/', neverCalled)).toBe(true)
    expect(await isUrlSafeToProbe('http://localhost:3000/', neverCalled)).toBe(true)
  })
})
