import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { expect, it } from 'vitest';
import { sessionCopyRequest } from './session-copy-request.js';
function fixture() {
  const req = Object.assign(new EventEmitter(), { aborted: false });
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
  const open = () => sessionCopyRequest(req as unknown as Request, res as unknown as Response);
  return { req, res, open };
}
it('does not confuse completed request-body close with a disconnected response', () => {
  const f = fixture(), lifetime = f.open(); f.req.emit('close'); expect(lifetime.signal.aborted).toBe(false);
  f.res.emit('close'); expect(lifetime.signal.aborted).toBe(true); lifetime.dispose();
});
it('captures a request abort and releases both owned listeners idempotently', () => {
  const f = fixture(), lifetime = f.open();
  expect(f.req.listenerCount('aborted')).toBe(1); expect(f.res.listenerCount('close')).toBe(1);
  f.req.emit('aborted'); expect(lifetime.signal.aborted).toBe(true); lifetime.dispose(); lifetime.dispose();
  expect(f.req.listenerCount('aborted')).toBe(0); expect(f.res.listenerCount('close')).toBe(0);
});
it('does not abort after a successfully ended response or disposed request lease', () => {
  const f = fixture(), lifetime = f.open(); f.res.writableEnded = true; f.res.emit('close'); expect(lifetime.signal.aborted).toBe(false);
  lifetime.dispose(); f.req.emit('aborted'); expect(lifetime.signal.aborted).toBe(false);
});
it.each(['request', 'response'] as const)('refuses an already disconnected %s', part => {
  const f = fixture(); if (part === 'request') f.req.aborted = true; else f.res.destroyed = true;
  const lifetime = f.open(); expect(lifetime.signal.aborted).toBe(true); lifetime.dispose();
});
