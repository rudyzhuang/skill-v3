#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  pickConnectedDevice,
  parseEmulatorIds,
} = require('./lib/mobile-device.cjs');

const devices = [
  {
    id: 'emu-1',
    name: 'Android Emulator',
    targetPlatform: 'android',
    emulator: true,
    isSupported: true,
  },
  {
    id: 'phone-usb',
    name: 'Pixel USB',
    targetPlatform: 'android',
    emulator: false,
    isSupported: true,
  },
  {
    id: 'iphone-sim',
    name: 'iPhone 16',
    targetPlatform: 'ios',
    emulator: true,
    isSupported: true,
  },
];

assert.equal(pickConnectedDevice(devices, 'android', '').id, 'phone-usb');
assert.equal(pickConnectedDevice(devices, 'android', '').kind, 'physical');

assert.equal(pickConnectedDevice(devices, 'android', 'emu-1').id, 'emu-1');

assert.equal(pickConnectedDevice(devices, 'ios', '').id, 'iphone-sim');

const emuOut = `apple_ios_simulator • iOS • ios\nPixel_3a • Phone • android`;
assert.deepEqual(parseEmulatorIds(emuOut, 'android'), ['Pixel_3a']);

console.error('selftest-mobile-device: ok');
