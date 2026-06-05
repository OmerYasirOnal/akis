import { describe, it, expect } from 'vitest'
import {
  validHost, validSshUser, validTargetDir, validAppPort, validPublicUrl, looksLikePem,
} from '../../src/publish/validate.js'

describe('publish validators (security boundary for argv-bound Settings input)', () => {
  it('validHost accepts plain hosts + IP literals, REJECTS option-injection + metachars', () => {
    expect(validHost('oci.example.com')).toBe(true)
    expect(validHost('132.226.10.5')).toBe(true)
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
