import { describe, expect, test } from 'bun:test'
import { detectProtocol, hostnameOf, isOwnGatewayCmd, parseCookieMode, parseSsListenPids, pickMode } from './gateway-lib'

describe('detectProtocol', () => {
  test('TLS ClientHello', () => {
    expect(detectProtocol(Uint8Array.of(0x16, 0x03, 0x01, 0x00))).toBe('tls')
  })
  test('SSH banner', () => {
    expect(detectProtocol(new TextEncoder().encode('SSH-2.0-OpenSSH'))).toBe('ssh')
  })
  test('HTTP GET', () => {
    expect(detectProtocol(new TextEncoder().encode('GET / HTTP/1.1\r\n'))).toBe('http')
  })
  test('need more bytes', () => {
    expect(detectProtocol(Uint8Array.of(0x16, 0x03))).toBe('wait')
  })
})

describe('pickMode', () => {
  const devHost = 'anyplane-dev.example.com'
  test('dev host wins over prod cookie', () => {
    expect(pickMode(devHost, 'anyplane-mode=prod', devHost)).toBe('dev')
  })
  test('cookie switches the shared prod domain', () => {
    expect(pickMode('anyplane.example.com', 'anyplane-mode=dev', devHost)).toBe('dev')
    expect(pickMode('anyplane.example.com', 'anyplane-mode=prod', devHost)).toBe('prod')
  })
  test('default is production', () => {
    expect(pickMode('anyplane.example.com', null, devHost)).toBe('prod')
  })
  test('query mode beats cookie', () => {
    expect(pickMode('anyplane.example.com', 'anyplane-mode=prod', devHost, 'dev')).toBe('dev')
    expect(pickMode('anyplane.example.com', 'anyplane-mode=dev', devHost, 'prod')).toBe('prod')
  })
  test('strips port from Host', () => {
    expect(hostnameOf('anyplane.example.com:80')).toBe('anyplane.example.com')
    expect(parseCookieMode('a=1; anyplane-mode=dev; b=2')).toBe('dev')
  })
})

describe('parseSsListenPids', () => {
  const sample = `
LISTEN 0 512 0.0.0.0:80 0.0.0.0:* users:(("bun",pid=1562281,fd=11))
LISTEN 0 512 0.0.0.0:443 0.0.0.0:* users:(("bun",pid=1562281,fd=12))
LISTEN 0 512 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=9,fd=1))
LISTEN 0 128 *:80 *:* users:(("nginx",pid=1,fd=8),("nginx",pid=2,fd=8))
`
  test('collects pids for exact port', () => {
    expect(parseSsListenPids(sample, 80).sort((a, b) => a - b)).toEqual([1, 2, 1562281])
    expect(parseSsListenPids(sample, 443)).toEqual([1562281])
    expect(parseSsListenPids(sample, 8080)).toEqual([9])
  })
  test('own gateway cmdline', () => {
    expect(isOwnGatewayCmd('bun\0--bun\0scripts/gateway.ts\0--insecure')).toBe(true)
    expect(isOwnGatewayCmd('/usr/sbin/sshd')).toBe(false)
  })
})
