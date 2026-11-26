import { describe, expect, it } from 'vitest';
import { ago, basename, bytes, dirname, duration, endpoint, parsePorts, percent, plural } from './format.js';

describe('format', () => {
  it('bytes', () => {
    expect(bytes(null)).toBe('—');
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(150 * 1024 * 1024)).toBe('150 MB');
  });

  it('percent and plural', () => {
    expect(percent(12.345)).toBe('12.3%');
    expect(percent(undefined)).toBe('—');
    expect(plural(1, 'port')).toBe('1 port');
    expect(plural(3, 'process', 'processes')).toBe('3 processes');
  });

  it('duration', () => {
    expect(duration(5000)).toBe('5s');
    expect(duration(5 * 60000)).toBe('5m');
    expect(duration(130 * 60000)).toBe('2h 10m');
    expect(duration(27 * 3600000)).toBe('1d 3h');
    expect(duration(-1)).toBe('—');
  });

  it('ago', () => {
    const now = 1_700_000_000_000;
    expect(ago(now - 2000, now)).toBe('just now');
    expect(ago(now - 30_000, now)).toBe('30s ago');
    expect(ago(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(ago(now - 26 * 3600_000, now)).toBe('yesterday');
    expect(ago(0, now)).toBe('—');
  });

  it('endpoint brackets IPv6', () => {
    expect(endpoint('127.0.0.1', 80)).toBe('127.0.0.1:80');
    expect(endpoint('::1', 5173)).toBe('[::1]:5173');
    expect(endpoint(null, 22)).toBe(':22');
  });

  it('paths', () => {
    expect(basename('C:\\Program Files\\nodejs\\node.exe')).toBe('node.exe');
    expect(dirname('C:\\Program Files\\nodejs\\node.exe')).toBe('C:\\Program Files\\nodejs');
    expect(basename('')).toBe('');
  });

  it('parsePorts', () => {
    expect(parsePorts('3000, 8080 3000').ports).toEqual([3000, 8080]);
    expect(parsePorts('5173-5175').ports).toEqual([5173, 5174, 5175]);
    expect(parsePorts('0').error).toBeTruthy();
    expect(parsePorts('70000').error).toBeTruthy();
    expect(parsePorts('9-3').error).toBeTruthy();
    expect(parsePorts('abc').error).toBeTruthy();
    expect(parsePorts('1-500').error).toMatch(/200/);
  });
});
