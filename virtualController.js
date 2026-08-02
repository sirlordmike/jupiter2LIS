// js/virtualController.js
// A low-poly "remote" living in the scene (distinct from the real XR
// controllers, which only supply input). It has its own Rapier rigid body
// so it behaves physically when dropped, and can be picked up with the
// right trigger. A small red button on its face toggles the sphere.

import * as THREE from 'three';


const GRAB_RADIUS = 0.12; // max distance from controller tip to grab the remote
const BODY_HALF_EXTENTS = { x: 0.025, y: 0.06, z: 0.025 };

// 6. const loader = new GLTFLoader();




export class VirtualController {
  constructor(scene, world, RAPIER, startPosition) {
    this.world = world;
    this.RAPIER = RAPIER;
    this.grabbed = false;
    this.onButtonPressed = null; // callback set by main.js

    this.group = new THREE.Group();
    this.group.position.copy(startPosition);
    scene.add(this.group);

    // --- Low-poly visual: a hexagonal-ish handle + flat top + button ---
    const lowPolyMat = new THREE.MeshStandardMaterial({
      color: 0x2b2f3a,
      roughness: 0.5,
      metalness: 0.3,
      flatShading: true,
    });

    const handleGeo = new THREE.CylinderGeometry(0.022, 0.026, 0.12, 6);
    const handle = new THREE.Mesh(handleGeo, lowPolyMat);
    handle.rotation.x = Math.PI / 2; // long axis points "forward" (-Z)
    this.group.add(handle);

    const capGeo = new THREE.ConeGeometry(0.026, 0.03, 6);
    const cap = new THREE.Mesh(capGeo, lowPolyMat);
    cap.position.z = -0.075;
    cap.rotation.x = -Math.PI / 2;
    this.group.add(cap);

    // The button: small flat cylinder on top, near the grip.
    this.buttonMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.01, 8),
      new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.4, flatShading: true })
    );
    this.buttonMesh.position.set(0, 0.028, 0.02);
    this.buttonMesh.rotation.x = Math.PI / 2;
    this.group.add(this.buttonMesh);

    // --- Physics body: starts dynamic so it rests under gravity until grabbed ---
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(startPosition.x, startPosition.y, startPosition.z)
      .setLinearDamping(0.6)
      .setAngularDamping(0.6)
      .setCcdEnabled(true);
    this.body = world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      BODY_HALF_EXTENTS.x,
      BODY_HALF_EXTENTS.y,
      BODY_HALF_EXTENTS.z
    )
      .setDensity(2.0)
      .setFriction(0.8);
    this.collider = world.createCollider(colliderDesc, this.body);

    this._prevPos = new THREE.Vector3().copy(startPosition);
    this._prevQuat = new THREE.Quaternion();
    this._tmpMat = new THREE.Matrix4();
  }

  // Distance check used by main.js to decide whether a grab attempt succeeds.
  distanceFrom(worldPoint) {
    const t = this.body.translation();
    return Math.hypot(t.x - worldPoint.x, t.y - worldPoint.y, t.z - worldPoint.z);
  }

  canGrabFrom(worldPoint) {
    return this.distanceFrom(worldPoint) <= GRAB_RADIUS;
  }

  // Called once when the right trigger is pressed near the remote.
  grab() {
    if (this.grabbed) return;
    this.grabbed = true;

    // Switch to kinematic so it follows the hand exactly with no jitter or
    // fighting against gravity/collision response while held.
    this.world.removeRigidBody(this.body);
    const t = this.group.position;
    const q = this.group.quaternion;
    const desc = this.RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(t.x, t.y, t.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    this.body = this.world.createRigidBody(desc);
    const colliderDesc = this.RAPIER.ColliderDesc.cuboid(
      BODY_HALF_EXTENTS.x,
      BODY_HALF_EXTENTS.y,
      BODY_HALF_EXTENTS.z
    )
      .setDensity(2.0)
      .setFriction(0.8);
    this.collider = this.world.createCollider(colliderDesc, this.body);
  }

  // Called when the right trigger is released while holding the remote.
  // Converts back to a dynamic body and hands it a sensible exit velocity
  // (estimated from recent motion) so it doesn't just freeze mid-air.
  release(estimatedVelocity) {
    if (!this.grabbed) return;
    this.grabbed = false;

    const t = this.body.translation();
    const r = this.body.rotation();
    this.world.removeRigidBody(this.body);

    const desc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(t.x, t.y, t.z)
      .setRotation(r)
      .setLinearDamping(0.6)
      .setAngularDamping(0.6)
      .setCcdEnabled(true);
    this.body = this.world.createRigidBody(desc);
    const colliderDesc = this.RAPIER.ColliderDesc.cuboid(
      BODY_HALF_EXTENTS.x,
      BODY_HALF_EXTENTS.y,
      BODY_HALF_EXTENTS.z
    )
      .setDensity(2.0)
      .setFriction(0.8);
    this.collider = this.world.createCollider(colliderDesc, this.body);

    if (estimatedVelocity) {
      // Clamp the throw velocity so a frame hitch right before release
      // can't fling the remote at unrealistic speed ("explosion" risk).
      const maxSpeed = 4.0;
      const speed = Math.hypot(estimatedVelocity.x, estimatedVelocity.y, estimatedVelocity.z);
      const scale = speed > maxSpeed ? maxSpeed / speed : 1;
      this.body.setLinvel(
        { x: estimatedVelocity.x * scale, y: estimatedVelocity.y * scale, z: estimatedVelocity.z * scale },
        true
      );
    }
  }

  // While grabbed, snap the kinematic body (and visual group) to the
  // controller's world transform every frame.
  followGrip(gripObject3D, dt) {
    if (!this.grabbed) return;

    this._prevPos.copy(this.group.position);
    this._prevQuat.copy(this.group.quaternion);

    gripObject3D.getWorldPosition(this.group.position);
    gripObject3D.getWorldQuaternion(this.group.quaternion);

    this.body.setNextKinematicTranslation(this.group.position);
    this.body.setNextKinematicRotation({
      x: this.group.quaternion.x,
      y: this.group.quaternion.y,
      z: this.group.quaternion.z,
      w: this.group.quaternion.w,
    });

    // Track an exit velocity estimate in case the user releases next frame.
    if (dt > 0) {
      this._exitVelocity = {
        x: (this.group.position.x - this._prevPos.x) / dt,
        y: (this.group.position.y - this._prevPos.y) / dt,
        z: (this.group.position.z - this._prevPos.z) / dt,
      };
    }
  }

  // Mirrors the Rapier body transform onto the three.js group (only
  // meaningful while NOT grabbed — while grabbed, followGrip already
  // drives both in lockstep).
  syncMesh() {
    if (this.grabbed) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    this.group.position.set(t.x, t.y, t.z);
    this.group.quaternion.set(r.x, r.y, r.z, r.w);
  }

  // World-space position of the button, for proximity-based "press" checks.
  getButtonWorldPosition(target) {
    return this.buttonMesh.getWorldPosition(target);
  }
}
