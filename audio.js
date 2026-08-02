// js/audio.js
// A quiet, low engine hum for the saucer — spatialized so it gets softer
// as you move away from it. Built directly with Web Audio oscillators
// rather than a sample, so there's nothing to load and the tone/volume
// are easy to tune in one place below.

import * as THREE from 'three';

// Two gently-detuned low sine waves (not a single pure tone) through a
// low-pass filter reads as a soft engine hum rather than a harsh buzz.
const HUM_FREQUENCY_A = 68;   // Hz
const HUM_FREQUENCY_B = 101;  // Hz — detuned from A so the hum has some texture
const FILTER_CUTOFF    = 260; // Hz — keeps only the low, soft part of the tone

// Deliberately quiet — this is the "too loud" fix. Volume eases up a
// little with altitude (see setAltitudeFactor) but never exceeds this.
const BASE_VOLUME = 0.05;
const ALTITUDE_VOLUME_BONUS = 0.02; // added on top of BASE_VOLUME at factor = 1
const ALTITUDE_PITCH_BONUS  = 10;   // Hz added to both oscillators at factor = 1

const FADE_TIME = 0.5; // seconds, smooth on/off — avoids clicks/pops

export class SaucerEngineSound {
  constructor(camera, targetMesh) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);

    this.sound = new THREE.PositionalAudio(this.listener);
    this.sound.setRefDistance(3);
    this.sound.setRolloffFactor(1.5);
    this.sound.setDistanceModel('inverse');
    this.sound.setMaxDistance(250);
    targetMesh.add(this.sound);

    const ctx = this.listener.context;

    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sine';
    this.oscA.frequency.value = HUM_FREQUENCY_A;

    this.oscB = ctx.createOscillator();
    this.oscB.type = 'sine';
    this.oscB.frequency.value = HUM_FREQUENCY_B;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = FILTER_CUTOFF;

    this.oscA.connect(this.filter);
    this.oscB.connect(this.filter);

    // Hands the filtered tone off to three.js's own gain/panner chain,
    // so volume control + 3D spatialization happen exactly like they
    // would for a loaded audio buffer.
    this.sound.setNodeSource(this.filter);
    this.sound.gain.gain.value = 0; // starts silent; setOn(true) fades it in

    this.oscA.start();
    this.oscB.start();

    this.isOn = false;
    this.altitudeFactor = 0;
  }

  // Browsers block audio until a user gesture; main.js calls this on the
  // first click/tap as a safety net.
  resume() {
    const ctx = this.listener.context;
    if (ctx.state === 'suspended') ctx.resume();
  }

  setOn(on) {
    if (on === this.isOn) return;
    this.isOn = on;
    this.resume();

    const ctx = this.listener.context;
    const now = ctx.currentTime;
    const target = on ? this._targetVolume() : 0;

    this.sound.gain.gain.cancelScheduledValues(now);
    this.sound.gain.gain.setValueAtTime(this.sound.gain.gain.value, now);
    this.sound.gain.gain.linearRampToValueAtTime(target, now + FADE_TIME);
  }

  // factor is 0–1 (how far up GLOW_HEIGHT_RANGE the saucer has climbed).
  // Nudges pitch and volume up slightly with altitude for a subtle
  // "throttling up" feel — stays a hum, never gets loud or revvy.
  setAltitudeFactor(factor) {
    this.altitudeFactor = THREE.MathUtils.clamp(factor, 0, 1);

    this.oscA.frequency.value = HUM_FREQUENCY_A + this.altitudeFactor * ALTITUDE_PITCH_BONUS;
    this.oscB.frequency.value = HUM_FREQUENCY_B + this.altitudeFactor * ALTITUDE_PITCH_BONUS;

    if (this.isOn) {
      const ctx = this.listener.context;
      const now = ctx.currentTime;
      this.sound.gain.gain.cancelScheduledValues(now);
      this.sound.gain.gain.setValueAtTime(this.sound.gain.gain.value, now);
      this.sound.gain.gain.linearRampToValueAtTime(this._targetVolume(), now + 0.2);
    }
  }

  _targetVolume() {
    return BASE_VOLUME + this.altitudeFactor * ALTITUDE_VOLUME_BONUS;
  }
}
