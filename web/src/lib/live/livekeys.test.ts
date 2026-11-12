// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { resolveLiveKey, type LiveKeyAction } from './livekeys';

type Ctx = Parameters<typeof resolveLiveKey>[1];
const base: Ctx = { tv: false, lg: false, controlsVisible: false, onBody: true, overlayOpen: false, numberOpen: false };
const r = (key: string, c: Partial<Ctx> = {}, m: object = {}): LiveKeyAction | null => resolveLiveKey({ key, ...m }, { ...base, ...c });
const tv = (key: string, c: Partial<Ctx> = {}) => r(key, { tv: true, ...c });

describe('resolveLiveKey desktop', () => {
  it('channel keys', () => {
    expect(r('ArrowUp')).toEqual({ type: 'chUp' });
    expect(r('PageUp')).toEqual({ type: 'chUp' });
    expect(r('ArrowDown')).toEqual({ type: 'chDown' });
    expect(r('PageDown')).toEqual({ type: 'chDown' });
  });
  it('play / pause on Space and K', () => {
    expect(r(' ')).toEqual({ type: 'toggle' });
    expect(r('k')).toEqual({ type: 'toggle' });
    expect(r('K')).toEqual({ type: 'toggle' });
  });
  it('seek 10 s with arrows, 30 s with J / L', () => {
    expect(r('ArrowLeft')).toEqual({ type: 'seek', by: -10 });
    expect(r('ArrowRight')).toEqual({ type: 'seek', by: 10 });
    expect(r('j')).toEqual({ type: 'seek', by: -30 });
    expect(r('L')).toEqual({ type: 'seek', by: 30 });
  });
  it('End = live, I = info, Q = last, M mute, F fullscreen, Escape closes', () => {
    expect(r('End')).toEqual({ type: 'live' });
    expect(r('i')).toEqual({ type: 'info' });
    expect(r('q')).toEqual({ type: 'last' });
    expect(r('m')).toEqual({ type: 'mute' });
    expect(r('f')).toEqual({ type: 'fullscreen' });
    expect(r('Escape')).toEqual({ type: 'close' });
  });
  it('digits; Enter only with the number card open', () => {
    expect(r('0')).toEqual({ type: 'digit', d: 0 });
    expect(r('7')).toEqual({ type: 'digit', d: 7 });
    expect(r('Enter')).toBeNull();
    expect(r('Enter', { numberOpen: true })).toEqual({ type: 'enter' });
  });
  it('Backspace is never last', () => { expect(r('Backspace')).toBeNull(); expect(tv('Backspace')).toBeNull(); });
  it('a focused control keeps Space and the arrows', () => {
    expect(r(' ', { onBody: false })).toBeNull();
    expect(r('ArrowUp', { onBody: false })).toBeNull();
    expect(r('PageUp', { onBody: false })).toEqual({ type: 'chUp' });
  });
  it('modifier combos belong to the browser', () => {
    expect(r('f', {}, { ctrlKey: true })).toBeNull();
    expect(r('ArrowLeft', {}, { altKey: true })).toBeNull();
    expect(r('1', {}, { metaKey: true })).toBeNull();
  });
  it('an open overlay swallows everything but Escape', () => {
    expect(r('ArrowUp', { overlayOpen: true })).toBeNull();
    expect(r('5', { overlayOpen: true })).toBeNull();
    expect(r('Escape', { overlayOpen: true })).toEqual({ type: 'close' });
  });
});

describe('resolveLiveKey TV', () => {
  it('ChannelUp / ChannelDown', () => {
    expect(tv('ChannelUp')).toEqual({ type: 'chUp' });
    expect(tv('ChannelDown')).toEqual({ type: 'chDown' });
  });
  it('up / down zap while the controls are hidden, and are left to focus when they show', () => {
    expect(tv('ArrowUp')).toEqual({ type: 'chUp' });
    expect(tv('ArrowDown')).toEqual({ type: 'chDown' });
    expect(tv('ArrowUp', { controlsVisible: true })).toBeNull();
    expect(tv('ArrowDown', { controlsVisible: true })).toBeNull();
  });
  it('OK with the controls hidden shows them, never toggles; with them visible the focused button owns it', () => {
    expect(tv('Enter')).toEqual({ type: 'showControls' });
    expect(tv('Enter')).not.toEqual({ type: 'toggle' });
    expect(tv('Enter', { controlsVisible: true })).toBeNull();
    expect(tv('Enter', { overlayOpen: true })).toBeNull();
  });
  it('OK with the number card open commits the number', () => { expect(tv('Enter', { numberOpen: true })).toEqual({ type: 'enter' }); });
  it('MediaPlayPause toggles; MediaRewind / FastForward seek 30 s', () => {
    expect(tv('MediaPlayPause')).toEqual({ type: 'toggle' });
    expect(tv('MediaRewind')).toEqual({ type: 'seek', by: -30 });
    expect(tv('MediaFastForward')).toEqual({ type: 'seek', by: 30 });
  });
  it('ChannelList and Guide open the channel list', () => {
    expect(tv('ChannelList')).toEqual({ type: 'channelList' });
    expect(tv('Guide')).toEqual({ type: 'channelList' });
  });
  it('left / right with the controls hidden show them with focus on -30 s / +30 s', () => {
    expect(tv('ArrowLeft')).toEqual({ type: 'controls', focus: 'back30' });
    expect(tv('ArrowRight')).toEqual({ type: 'controls', focus: 'fwd30' });
    expect(tv('ArrowLeft', { controlsVisible: true })).toBeNull();
  });
  it('PreviousChannel = last, Info = info', () => {
    expect(tv('PreviousChannel')).toEqual({ type: 'last' });
    expect(tv('Info')).toEqual({ type: 'info' });
  });
  it('letters stay free on the TV; digits work', () => {
    for (const k of ['k', 'q', 'i', 'f', 'm', 'j', ' ']) expect(tv(k)).toBeNull();
    expect(tv('4')).toEqual({ type: 'digit', d: 4 });
  });
  it('PageUp / PageDown are channel keys when they arrive', () => {
    expect(tv('PageUp')).toEqual({ type: 'chUp' });
    expect(tv('PageDown')).toEqual({ type: 'chDown' });
  });
});

describe('resolveLiveKey LG', () => {
  const lg = (key: string, c: Partial<Ctx> = {}) => r(key, { tv: true, lg: true, ...c });
  it('Red = last, Blue = live', () => {
    expect(lg('ColorF0Red')).toEqual({ type: 'last' });
    expect(lg('ColorF3Blue')).toEqual({ type: 'live' });
  });
  it('the colour keys do nothing outside the LG app', () => {
    expect(tv('ColorF0Red')).toBeNull();
    expect(tv('ColorF3Blue')).toBeNull();
  });
  it('ArrowUp zaps without any PageUp ever seen', () => { expect(lg('ArrowUp')).toEqual({ type: 'chUp' }); });
  it('Info works on LG', () => { expect(lg('Info')).toEqual({ type: 'info' }); });
});
