import { describe, expect, test } from 'bun:test'
import { detectProtocol, isOwnGatewayCmd, parseCookieMode, pickMode } from './gateway-lib'

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
  test('cookie 串里挑出 anyplane-mode', () => {
    expect(parseCookieMode('a=1; anyplane-mode=dev; b=2')).toBe('dev')
  })
})

describe('isOwnGatewayCmd', () => {
  test('cmdline 含 scripts/gateway.ts → 自己人；其余进程不误杀', () => {
    expect(isOwnGatewayCmd('bun\0--bun\0scripts/gateway.ts\0--insecure')).toBe(true)
    expect(isOwnGatewayCmd('/usr/sbin/sshd')).toBe(false)
  })
})
