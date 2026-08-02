import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SaucerEngineSound } from './audio.js';
import { JUPITER_GLB } from './models.js';

/* ------------------------------------------------------------------ *
 *  CONSTANTS
 * ------------------------------------------------------------------ */
const FLOOR_Y = 0;

// Toy scale: the saucer's visual size matches the physics ball collider
// directly, same as the very first version of this project — a small
// hand/floating toy, not a life-sized ship.
const SPHERE_RADIUS = 0.15;
const FIXED_TIMESTEP = 1 / 90;       // stable substep, independent of Quest's render Hz
const MAX_SUBSTEPS = 4;

// Imported model assets are embedded as base64 data URLs in models.js —
// no server path or CORS issues regardless of how the project is hosted.
const JUPITER_MODEL_URL    = JUPITER_GLB;
const JUPITER_TARGET_SIZE = SPHERE_RADIUS * 2;  // visually matches the physics ball collider

// Used ONLY as the reference height for scaling the PLAYER when they
// teleport into the bridge (see setupSphere / teleportPlayerScale) — a
// 6 ft (1.83 m) person + ~20% headroom. This is independent of the
// saucer's own visual scale above: teleportPlayerScale is a ratio
// (bridge's real height ÷ this constant), so at toy scale it correctly
// works out to a much smaller shrink factor, fitting the player to the
// now much tinier toy-scale bridge instead of towering over the ship.
const SIX_FOOT_MAN_M = 1.8288;
const SAUCER_HEIGHT_M = SIX_FOOT_MAN_M * 1.2;

const SPHERE_MOVE_SPEED = 1.6;       // m/s for stick-driven axes — toy-scale speed
const Z_BASE_SPEED = 1.2;            // base forward/back speed
const Z_ACCEL_MULTIPLIER = 3.0;      // extra multiplier range from left trigger
const STICK_DEADZONE = 0.12;

const COLOR_OFF = 0xb8c4cc;          // metallic light gray
const COLOR_ON  = 0xf0f8ff;          // near-white for bloom
const GLOW_COLOR = 0xffffff;         // pure white glow while airborne
const GLOW_HEIGHT_RANGE = 1.2;       // meters of lift to reach full glow brightness
const GLOW_MAX_LIGHT_INTENSITY = 0.6;
// A light layer separate from the scene's default (0). Nothing currently
// opts into it, which is deliberate: the glow light's visible effect was
// entirely "lights up the floor beneath the saucer" — the saucer's own
// glow comes from its emissive materials (see updateSphereGlow), not
// from this point light illuminating its own surface from inside.
const GLOW_LIGHT_LAYER = 1;
const GLOW_MAX_EMISSIVE = 0.5;       // subtle bloom, won't wash out windows
const GLOW_LERP_SPEED = 8;

// Collision groups (Rapier interaction groups: 16-bit membership | 16-bit filter)
const GROUP_FLOOR      = 1 << 0;
const GROUP_SPHERE     = 1 << 1;

function makeGroups(membership, filter) {
  return (membership << 16) | filter;
}

/* ------------------------------------------------------------------ *
 *  GLOBAL STATE
 * ------------------------------------------------------------------ */
let scene, camera, renderer, clock;
let world;
let physicsAccumulator = 0;

let floorBody, floorMesh;
let starField;
let sphereBody, sphereMesh, sphereOn = false, sphereGlowLight, sphereMaterials = [];
let windowMaterials = [];
let flashLightsNode = null, flashLightsLight = null;
let bulbGroupNode = null, bulbMaterials = [];
let engineSound;

const gltfLoader = new GLTFLoader();

let rightController, leftController, rightGrip, leftGrip;
let rightInputSource = null, leftInputSource = null;
let prevButtonState = false;
let prevTeleportButtonState = false;
let rightLabelMesh = null, leftLabelMesh = null;

// The saucer's "teleport_locator" node (its boarding anchor, positioned
// at the bridge's floor) — stays parented under the flying saucer, so we
// read its live world position each time the player teleports to it.
let jupiterLocatorNode = null;
// How much to shrink the player when teleporting into the bridge, so its
// tiny modeled interior reads as human-scale around them. Computed once
// the model loads, from the bridge mesh's real (post-scale) size — see
// setupSphere(). 1 = no shrink (used until the model has loaded).
let teleportPlayerScale = 1;
let isTeleportedToBridge = false;

// Everything the player's viewpoint depends on — camera + both XR
// controllers — lives under this rig instead of directly in the scene.
// WebXR composes the tracked headset/controller pose with this rig's own
// transform, so moving the rig teleports the player and *scaling* the
// rig is what makes the bridge feel properly sized around them (a
// standard WebXR "dolly" technique).
let playerRig;

// The city environment pulled out of the Jupiter2 asset in setupSphere().
// Kept globally so revealGalaxy() can remove it once the galaxy loads.
let cityGroup = null;

// Galaxy — generated in the background while the player is flying around
// the city, then swapped in for it. See generateGalaxy() / revealGalaxy().
let galaxyGeometry = null, galaxyMaterial = null, galaxyPoints = null;
let galaxyRevealed = false;

init();

/* ------------------------------------------------------------------ *
 *  INITIALISATION
 * ------------------------------------------------------------------ */
async function init() {
  await RAPIER.init();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0c10);
  scene.fog = new THREE.Fog(0x0a0c10, 150, 600);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 8000);
  camera.position.set(0, 1.6, 2.5);

  playerRig = new THREE.Group();
  playerRig.add(camera);
  scene.add(playerRig);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);
  document.body.appendChild(VRButton.createButton(renderer));

  clock = new THREE.Clock();

  setupLighting();
  setupStarfield();
  setupPhysicsWorld();
  setupFloor();
  // Physics body inside this is created synchronously before its GLB
  // load resolves, so gravity/collisions are live immediately even
  // while the visual model is still streaming in.
  await setupSphere();
  setupXRControllers();
  setupControllerLabels();

  engineSound = new SaucerEngineSound(camera, sphereMesh);
  document.body.addEventListener('click', () => engineSound.resume(), { once: false });

  window.addEventListener('resize', onWindowResize);
  renderer.setAnimationLoop(renderLoop);
}

function setupLighting() {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 1.1);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 1.4);
  dir.position.set(3, 6, 2);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.near = 0.5;
  dir.shadow.camera.far = 20;
  scene.add(dir);
}

/* ------------------------------------------------------------------ *
 *  STARFIELD — a vast shell of points surrounding the whole scene, for
 *  an immersive night-sky backdrop. Lives well beyond the scene's fog
 *  range (fog is disabled on this material) so the stars stay crisp no
 *  matter how far the sphere/controller wander.
 * ------------------------------------------------------------------ */
const STAR_COUNT = 3500;
const STAR_MIN_RADIUS = 60;
const STAR_MAX_RADIUS = 140;

const STAR_VERTEX_SHADER = `
  attribute float size;
  attribute float phase;
  attribute vec3 color;
  varying vec3 vColor;
  varying float vPhase;
  void main() {
    vColor = color;
    vPhase = phase;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    // Fixed pixel size (no perspective attenuation) keeps distant stars
    // crisp and tiny instead of the blocky over-sized squares we had.
    gl_PointSize = size;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const STAR_FRAGMENT_SHADER = `
  uniform float uTime;
  varying vec3 vColor;
  varying float vPhase;
  void main() {
    // Soft circular falloff so each star is a smooth dot, not a hard square.
    vec2 centered = gl_PointCoord - vec2(0.5);
    float dist = length(centered);
    float alpha = smoothstep(0.5, 0.05, dist);
    if (alpha <= 0.001) discard;
    float twinkle = 0.55 + 0.45 * sin(uTime * 1.6 + vPhase);
    gl_FragColor = vec4(vColor, alpha * twinkle);
  }
`;

function setupStarfield() {
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  const phases = new Float32Array(STAR_COUNT);

  const color = new THREE.Color();

  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniformly distribute points on a spherical shell (random radius
    // band, not just the surface) so the sky reads with subtle depth.
    const radius = THREE.MathUtils.lerp(STAR_MIN_RADIUS, STAR_MAX_RADIUS, Math.random());
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(THREE.MathUtils.lerp(-1, 1, Math.random()));

    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.cos(phi);
    const z = radius * Math.sin(phi) * Math.sin(theta);

    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // Mostly cool white, with an occasional warm or blue-tinted star.
    const tint = Math.random();
    if (tint > 0.92) color.setHSL(0.58, 0.6, 0.85);      // faint blue
    else if (tint > 0.84) color.setHSL(0.08, 0.5, 0.8);  // faint warm amber
    else color.setHSL(0.0, 0.0, THREE.MathUtils.lerp(0.7, 1.0, Math.random()));
    color.toArray(colors, i * 3);

    // Pixel-space sizes — small by default, with rare brighter "hero" stars.
    sizes[i] = THREE.MathUtils.lerp(1.0, 3.0, Math.pow(Math.random(), 4));
    phases[i] = Math.random() * Math.PI * 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: STAR_VERTEX_SHADER,
    fragmentShader: STAR_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });

  starField = new THREE.Points(geometry, material);
  starField.frustumCulled = false; // it's a giant shell around the player; never cull it
  scene.add(starField);
}

/* ------------------------------------------------------------------ *
 *  Gentle drift + per-star twinkle (driven by the shader's uTime) so
 *  the sky doesn't feel static.
 * ------------------------------------------------------------------ */
function updateStarfield(elapsed) {
  if (!starField) return;
  starField.rotation.y = elapsed * 0.004; // slow celestial drift
  starField.material.uniforms.uTime.value = elapsed;
}

/* ------------------------------------------------------------------ *
 *  GALAXY — a spiral of colored points that replaces the city once it's
 *  generated. Adapted from a standalone Three.js galaxy-generator sketch
 *  (the kind built in the classic "Galaxy Generator" tutorial pattern):
 *  positions are laid out along `branches` spiral arms with power-curved
 *  random scatter, colored by a lerp from an inside to an outside color,
 *  and a custom shader spins each point around Y at a rate inversely
 *  proportional to its distance from the center (so the core visibly
 *  spins faster than the arms, like real differential rotation) and
 *  sizes each point with perspective attenuation.
 *
 *  Sized for THIS scene rather than the sketch's tabletop scale: our
 *  world is human/real-world scaled (saucer ≈6.5m, city ≈70m across),
 *  so the galaxy's radius is set large enough (see GALAXY_RADIUS) to
 *  read as a real backdrop the player flies through, not a tabletop
 *  ornament. Point count is trimmed from the sketch's default 200,000
 *  down to GALAXY_COUNT — comfortably inside VR's frame budget on Quest
 *  3 (see the point-count discussion for the existing starfield above)
 *  while still reading as dense.
 * ------------------------------------------------------------------ */
const GALAXY_COUNT = 100000;
const GALAXY_RADIUS = 4400;
const GALAXY_BRANCHES = 4;
const GALAXY_RANDOMNESS = 0.35;
const GALAXY_RANDOMNESS_POWER = 3;
const GALAXY_POINT_SIZE = 150;
// Distance (in meters) at which a point renders at its full base size.
// The original sketch's raw "1 / distance" falloff was tuned for a
// camera sitting a few units away; at our scene's scale (a galaxy
// spanning thousands of meters) that math crushed almost every point to
// sub-pixel, leaving only the handful closest to the camera visible —
// which is why it looked sparse instead of massive. Normalizing against
// this reference distance keeps points a readable size across the whole
// structure instead of only right next to the camera.
const GALAXY_SIZE_REFERENCE_DISTANCE = 900;
const GALAXY_SPIN_SPEED = 880;        // scaled for GALAXY_RADIUS=4400 vs the original demo's radius=5 (4400/5), so the edge spins at the same relative rate the original did
const GALAXY_INSIDE_COLOR = '#ff6030';
const GALAXY_OUTSIDE_COLOR = '#1b3984';
// Fly the saucer above this altitude (meters above the floor) to trigger
// the swap — well above the (now toy-scale) city's tallest buildings,
// so it reads as "flying out into space" rather than an arbitrary timer.
const GALAXY_REVEAL_ALTITUDE = 4.5; // was 100 at human scale; city shrinks with the saucer, so rescaled to match
// How high above the floor the galaxy itself sits once revealed — kept
// separate from the trigger altitude above so it can sit well clear of
// the grid rather than right at head height when it first appears.
const GALAXY_HEIGHT_ABOVE_FLOOR = 40;

const GALAXY_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uSize;

  attribute vec3 aRandomness;
  attribute float aScale;

  varying vec3 vColor;

  void main() {
    // Position
    vec4 modelPosition = modelMatrix * vec4(position, 1.0);

    // Rotate — differential spin: points closer to the center revolve
    // faster. (uTime is pre-scaled by GALAXY_SPIN_SPEED on the JS side.)
    float angle = atan(modelPosition.x, modelPosition.z);
    float distanceToCenter = length(modelPosition.xz);
    float angleOffset = (1.0 / max(distanceToCenter, 0.001)) * uTime;
    angle += angleOffset;
    modelPosition.x = cos(angle) * distanceToCenter;
    modelPosition.z = sin(angle) * distanceToCenter;

    // Randomness
    modelPosition.xyz += aRandomness;

    vec4 viewPosition = viewMatrix * modelPosition;
    vec4 projectedPosition = projectionMatrix * viewPosition;
    gl_Position = projectedPosition;

    /**
     * Size — the original "1 / -viewPosition.z" falloff is tuned for a
     * camera sitting a few units away; at our scene's scale (a galaxy
     * spanning thousands of meters) that crushes almost every point to
     * sub-pixel. Normalized against a reference distance instead, so
     * points stay a readable size across the whole structure.
     */
    float dist = max(-viewPosition.z, 0.001);
    gl_PointSize = uSize * aScale * (${GALAXY_SIZE_REFERENCE_DISTANCE.toFixed(1)} / dist);
    gl_PointSize = clamp(gl_PointSize, 0.8, 16.0); // never vanish, never blow out right on top of the camera

    /**
     * Color
     */
    vColor = color;
  }
`;

const GALAXY_FRAGMENT_SHADER = `
  varying vec3 vColor;

  void main() {
    // Light point
    float strength = distance(gl_PointCoord, vec2(0.5));
    strength = 1.0 - strength;
    strength = pow(strength, 10.0);

    // Final color
    vec3 color = mix(vec3(0.0), vColor, strength);
    gl_FragColor = vec4(color, 1.0);
  }
`;

function generateGalaxy() {
  if (galaxyPoints !== null) {
    galaxyGeometry.dispose();
    galaxyMaterial.dispose();
    scene.remove(galaxyPoints);
  }

  galaxyGeometry = new THREE.BufferGeometry();

  const positions = new Float32Array(GALAXY_COUNT * 3);
  const randomness = new Float32Array(GALAXY_COUNT * 3);
  const colors = new Float32Array(GALAXY_COUNT * 3);
  const scales = new Float32Array(GALAXY_COUNT);

  const insideColor = new THREE.Color(GALAXY_INSIDE_COLOR);
  const outsideColor = new THREE.Color(GALAXY_OUTSIDE_COLOR);

  for (let i = 0; i < GALAXY_COUNT; i++) {
    const i3 = i * 3;

    const radius = Math.random() * GALAXY_RADIUS;
    const branchAngle = ((i % GALAXY_BRANCHES) / GALAXY_BRANCHES) * Math.PI * 2;

    const randomX = Math.pow(Math.random(), GALAXY_RANDOMNESS_POWER) * (Math.random() < 0.5 ? 1 : -1) * GALAXY_RANDOMNESS * radius;
    const randomY = Math.pow(Math.random(), GALAXY_RANDOMNESS_POWER) * (Math.random() < 0.5 ? 1 : -1) * GALAXY_RANDOMNESS * radius;
    const randomZ = Math.pow(Math.random(), GALAXY_RANDOMNESS_POWER) * (Math.random() < 0.5 ? 1 : -1) * GALAXY_RANDOMNESS * radius;

    positions[i3] = Math.cos(branchAngle) * radius;
    positions[i3 + 1] = 0;
    positions[i3 + 2] = Math.sin(branchAngle) * radius;

    randomness[i3] = randomX;
    randomness[i3 + 1] = randomY;
    randomness[i3 + 2] = randomZ;

    const mixedColor = insideColor.clone().lerp(outsideColor, radius / GALAXY_RADIUS);
    colors[i3] = mixedColor.r;
    colors[i3 + 1] = mixedColor.g;
    colors[i3 + 2] = mixedColor.b;

    scales[i] = Math.random();
  }

  galaxyGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  galaxyGeometry.setAttribute('aRandomness', new THREE.BufferAttribute(randomness, 3));
  galaxyGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  galaxyGeometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));

  galaxyMaterial = new THREE.ShaderMaterial({
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: GALAXY_POINT_SIZE * renderer.getPixelRatio() },
    },
    vertexShader: GALAXY_VERTEX_SHADER,
    fragmentShader: GALAXY_FRAGMENT_SHADER,
  });

  galaxyPoints = new THREE.Points(galaxyGeometry, galaxyMaterial);
  galaxyPoints.position.y = FLOOR_Y + GALAXY_HEIGHT_ABOVE_FLOOR; // well above the grid, not just at the reveal trigger height
  galaxyPoints.frustumCulled = false;
  scene.add(galaxyPoints);
}

// Runs once, the moment the saucer climbs above GALAXY_REVEAL_ALTITUDE:
// generates the galaxy (a brief one-time cost — see GALAXY_COUNT comment
// above) and removes the city, so the player transitions from flying
// over a city to flying through open space, timed to when they actually
// fly up out of it rather than an arbitrary clock.
function revealGalaxy() {
  generateGalaxy();

  if (cityGroup) {
    scene.remove(cityGroup);
    cityGroup.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material?.dispose();
      }
    });
    cityGroup = null;
  }

  // Deep space doesn't want the city's fog falloff.
  scene.fog = null;

  galaxyRevealed = true;
}

function updateGalaxy(dt, elapsed) {
  if (!galaxyRevealed && sphereMesh) {
    const altitude = sphereMesh.position.y - FLOOR_Y;
    if (altitude >= GALAXY_REVEAL_ALTITUDE) {
      revealGalaxy();
    }
  }
  if (galaxyPoints) {
    galaxyMaterial.uniforms.uTime.value = elapsed * GALAXY_SPIN_SPEED;
  }
}

/* ------------------------------------------------------------------ *
 *  PHYSICS WORLD — gravity active from the very first frame
 * ------------------------------------------------------------------ */
function setupPhysicsWorld() {
  world = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
  world.timestep = FIXED_TIMESTEP;
}

/* ------------------------------------------------------------------ *
 *  FLOOR — static collider, no bounds on X/Z (infinite-feeling plane)
 * ------------------------------------------------------------------ */
function setupFloor() {
  const size = 200; // visually large; physics collider matches generously
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.95, metalness: 0.05 });
  floorMesh = new THREE.Mesh(geo, mat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = FLOOR_Y;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  const grid = new THREE.GridHelper(size, size / 2, 0x3a4250, 0x262b33);
  grid.position.y = FLOOR_Y + 0.001;
  scene.add(grid);

  const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, FLOOR_Y - 0.1, 0);
  floorBody = world.createRigidBody(bodyDesc);

  // Thin, generously-sized cuboid so nothing tunnels through at the edges.
  const colDesc = RAPIER.ColliderDesc.cuboid(size / 2, 0.1, size / 2)
    .setFriction(1.0)
    .setRestitution(0.0)
    .setCollisionGroups(makeGroups(GROUP_FLOOR, GROUP_SPHERE));
  world.createCollider(colDesc, floorBody);
}

/* ------------------------------------------------------------------ *
 *  Wrap a loaded glTF scene in a centering/scaling pivot so imported
 *  assets (whatever their authored scale/origin) drop in at a known
 *  size, centered on their own local origin — same contract our
 *  procedural geometry used to provide.
 * ------------------------------------------------------------------ */
function normalizeAndCenterModel(root, targetSize) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = targetSize / maxDim;

  const wrapper = new THREE.Group();
  root.position.sub(center); // recenter so the model's visual bbox center sits at the wrapper's origin
  wrapper.add(root);
  wrapper.scale.setScalar(scale);
  return { wrapper, scale, center };
}

/* ------------------------------------------------------------------ *
 *  INTERACTION SPHERE — dynamic body, gravity active, rests on floor.
 *  Visual is the imported Jupiter2.glb model; physics still uses a
 *  simple invisible ball collider for guaranteed solver stability.
 *  All rotations are locked so the model never tumbles when moving.
 * ------------------------------------------------------------------ */
async function setupSphere() {
  const SPAWN_Z = -0.6; // close spawn, appropriate for a small toy-scale saucer

  sphereMesh = new THREE.Group();
  sphereMesh.position.set(0, SPHERE_RADIUS, SPAWN_Z); // starts at floor level
  scene.add(sphereMesh);

  // Soft point light that lives inside the model and brightens as it
  // lifts off the floor, giving it a "luminous take-off" glow. Restricted
  // to its own light layer (not the default layer everything else is
  // on), so it doesn't wash the floor out white when the saucer hovers
  // low over it — floor lighting stays purely from the hemisphere/
  // directional lights.
  sphereGlowLight = new THREE.PointLight(0xffffff, 0, 2.5, 2.0);
  sphereGlowLight.position.set(0, 0, 0);
  sphereGlowLight.layers.set(GLOW_LIGHT_LAYER);
  sphereMesh.add(sphereGlowLight);

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, SPHERE_RADIUS, SPAWN_Z)
    .setLinearDamping(0.4)
    .setAngularDamping(0.6)
    .setCcdEnabled(true);
  sphereBody = world.createRigidBody(bodyDesc);
  // Lock ALL rotation axes so Jupiter2 never tumbles when moving.
  // lockRotations() is stable across all rapier3d-compat 0.x versions.
  sphereBody.lockRotations(true);

  const colDesc = RAPIER.ColliderDesc.ball(SPHERE_RADIUS)
    .setFriction(0.8)
    .setRestitution(0.05)
    .setDensity(1.2)
    .setCollisionGroups(makeGroups(GROUP_SPHERE, GROUP_FLOOR));
  world.createCollider(colDesc, sphereBody);

  // Load the visual model and attach it once ready.
  const gltf = await gltfLoader.loadAsync(JUPITER_MODEL_URL);
  const modelRoot = gltf.scene;
  modelRoot.updateMatrixWorld(true); // world positions below need this up to date

  // The Jupiter2 asset also ships a "teleport_locator" anchor (positioned
  // at the bridge's floor), a "bridge" cockpit interior mesh, and a small
  // city environment (pPlane2 = ground, static = buildings) in the same
  // file. Pull the city out into its own group BEFORE sizing the saucer,
  // so its much larger geometry doesn't skew the saucer's auto-scale —
  // the saucer keeps exactly the footprint it always has. attach()
  // (rather than add()) preserves each part's world transform while
  // reparenting, so nothing jumps position when it's pulled out.
  const locatorNode = modelRoot.getObjectByName('teleport_locator');
  jupiterLocatorNode = locatorNode; // kept globally: this node stays parented under the
                                     // saucer and moves with it, so its live world position
                                     // is exactly where the teleport button should send the player
  const locatorLoaderPos = locatorNode
    ? locatorNode.getWorldPosition(new THREE.Vector3())
    : null;

  // Measure the bridge's raw (pre-scale) size — bbox size is translation
  // -invariant, so this is valid whether measured before or after the
  // saucer gets recentered below. Bbox size does NOT depend on the
  // uniform `scale` we're about to compute, so we can multiply by it
  // after the fact to get the bridge's real, human-comparable size.
  const bridgeNode = modelRoot.getObjectByName('bridge');
  const bridgeHeightLoader = bridgeNode
    ? new THREE.Box3().setFromObject(bridgeNode).getSize(new THREE.Vector3()).y
    : null;

  // Only treat this as "the model has a bundled city" if pPlane2 (the
  // actual ground-plane marker) is present. Some versions of this asset
  // ship saucer-only, with no city — and in those, a node happens to be
  // named 'static' too, but as a legitimate saucer part, not a building.
  // Blindly pulling anything named 'static' out would break the saucer
  // in that case, so pPlane2's presence gates the whole extraction.
  cityGroup = new THREE.Group();
  if (modelRoot.getObjectByName('pPlane2')) {
    ['pPlane2', 'static'].forEach((name) => {
      const node = modelRoot.getObjectByName(name);
      if (node) cityGroup.attach(node);
    });
  }

  const { wrapper, scale } = normalizeAndCenterModel(modelRoot, JUPITER_TARGET_SIZE);
  sphereMesh.add(wrapper);

  // The bridge is a tiny fraction of an already toy-scale saucer, so we
  // shrink the PLAYER to fit inside it: bridge's real (post-scale) height,
  // over a fixed 6 ft-person-plus-headroom reference (SAUCER_HEIGHT_M).
  // Because this is a ratio, it automatically produces a smaller shrink
  // factor at toy scale than it would at a life-sized scale — the player
  // ends up correctly tiny to match the correspondingly tiny bridge.
  if (bridgeHeightLoader) {
    const bridgeHeightReal = bridgeHeightLoader * scale;
    teleportPlayerScale = bridgeHeightReal / SAUCER_HEIGHT_M;
  } else {
    console.warn('[Jupiter2] bridge mesh not found — teleport will not rescale the player.');
  }

  // Place the city so the locator lands at the player's floor-level
  // spawn point — this is what "teleports" the player to the right
  // spot relative to the city on load, using the same scale as the
  // saucer so relative proportions/distances stay as the artist set them.
  if (cityGroup.children.length) {
    cityGroup.scale.setScalar(scale);

    const spawnPoint = new THREE.Vector3(0, FLOOR_Y, 0);
    if (locatorLoaderPos) {
      cityGroup.position.copy(spawnPoint).addScaledVector(locatorLoaderPos, -scale);
    } else {
      console.warn('[Jupiter2] teleport_locator node not found — city placed at scaled origin.');
      cityGroup.position.copy(spawnPoint);
    }

    cityGroup.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });

    scene.add(cityGroup);
  }

  sphereMaterials = [];
  modelRoot.traverse((obj) => {
    if (obj.isMesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      // Smooth polished metal across the whole saucer.
      obj.material.metalness = 0.90;
      obj.material.roughness = 0.12;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => { if (m) sphereMaterials.push(m); });
    }

    // "bulb" — the spherical bowl on top. Warm white-yellow tint so it
    // lights up distinctly and stands out from the saucer body.
    if (obj.name === 'bulb') {
      obj.traverse((child) => {
        if (!child.isMesh) return;
        child.material = child.material.clone();
        child.material.color.setHex(0xfffde8);
        child.material.emissive = new THREE.Color(0xffee99);
        child.material.emissiveIntensity = 0.5;
        child.material.metalness = 0.4;
        child.material.roughness = 0.2;
      });
    }

    // "windows" — dark solid panels, matte, no glow.
    if (obj.name === 'windows') {
      obj.traverse((child) => {
        if (!child.isMesh) return;
        child.material = child.material.clone();
        child.material.color.setHex(0x000000); // pure black
        child.material.emissive = new THREE.Color(0x000000);
        child.material.emissiveIntensity = 0;
        child.material.metalness = 0.0;
        child.material.roughness = 1.0;
        // Collect separately so bloom never touches them.
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => { if (m && !windowMaterials.includes(m)) windowMaterials.push(m); });
        // Remove from sphereMaterials if already added by the general isMesh pass.
        sphereMaterials = sphereMaterials.filter((m) => !windowMaterials.includes(m));
      });
    }

    // flashLights — the separate bottom geometry that spins on Y and
    // emits a luminous white glow. Spin speed rises with altitude.
    if (obj.name === 'flashLights') {
      flashLightsNode = obj;
      console.log('[Jupiter2] flashLights node found:', obj);
      flashLightsLight = new THREE.PointLight(0xffffff, 0, 1.2, 2.0);
      flashLightsLight.position.set(0, 0, 0);
      obj.add(flashLightsLight);
      // Ensure the material has emissive support from the start.
      obj.traverse((child) => {
        if (!child.isMesh) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          if (!m) return;
          m.emissive = new THREE.Color(0xffffff);
          m.emissiveIntensity = 0;
        });
      });
    }

    // bulb1 — the upper saucer assembly including the top dome. Collect
    // its mesh materials so we can apply the white bloom on/off state.
    if (obj.name === 'bulb1') {
      bulbGroupNode = obj;
    }
  });

  // Collect bulb1 mesh materials separately after full traverse so all
  // descendants are guaranteed to have been visited already.
  if (bulbGroupNode) {
    bulbGroupNode.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => {
        if (m && !bulbMaterials.includes(m)) bulbMaterials.push(m);
      });
    });
  }

  setSphereOn(sphereOn);
}

function setSphereOn(on) {
  sphereOn = on;

  sphereMaterials.forEach((m) => {
    if (m.color) m.color.setHex(on ? COLOR_ON : COLOR_OFF);
    if (m.emissive) m.emissive.setHex(on ? 0x888888 : 0x000000);
    if ('emissiveIntensity' in m) m.emissiveIntensity = on ? 0.25 : 0.0;
  });

  // flashLights point light and mesh emissive — active only when On.
  if (flashLightsLight) flashLightsLight.intensity = on ? 1.4 : 0;
  if (flashLightsNode) {
    flashLightsNode.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => { if (m) m.emissiveIntensity = on ? 0.8 : 0; });
    });
  }

  const collider = sphereBody.collider(0);
  if (collider) {
    collider.setCollisionGroups(makeGroups(GROUP_SPHERE, GROUP_FLOOR));
  }

  if (engineSound) engineSound.setOn(on);
}

/* ------------------------------------------------------------------ *
 *  XR CONTROLLERS (the physical Quest 3 Touch Plus controllers)
 * ------------------------------------------------------------------ */
function setupXRControllers() {
  const modelFactory = new XRControllerModelFactory();

  rightController = renderer.xr.getController(0);
  leftController = renderer.xr.getController(1);
  rightGrip = renderer.xr.getControllerGrip(0);
  leftGrip = renderer.xr.getControllerGrip(1);

  playerRig.add(rightController, leftController, rightGrip, leftGrip);

  rightGrip.add(modelFactory.createControllerModel(rightGrip));
  leftGrip.add(modelFactory.createControllerModel(leftGrip));

  // Identify handedness as soon as a controller connects, and re-resolve
  // index 0/1 -> left/right because XR input source order is not guaranteed.
  rightController.addEventListener('connected', (e) => assignHandedness(e, 0));
  leftController.addEventListener('connected', (e) => assignHandedness(e, 1));
  rightController.addEventListener('disconnected', () => { rightInputSource = null; });
  leftController.addEventListener('disconnected', () => { leftInputSource = null; });
}

function assignHandedness(event, controllerIndex) {
  const src = event.data;
  // The grip at the same index as the controller that just connected.
  const grip = controllerIndex === 0 ? rightGrip : leftGrip;

  if (src.handedness === 'right') {
    rightInputSource = src;
    // Attach the RIGHT label to whatever physical grip this is.
    if (rightLabelMesh && !grip.children.includes(rightLabelMesh)) {
      grip.add(rightLabelMesh);
    }
  } else if (src.handedness === 'left') {
    leftInputSource = src;
    // Attach the LEFT label to whatever physical grip this is.
    if (leftLabelMesh && !grip.children.includes(leftLabelMesh)) {
      grip.add(leftLabelMesh);
    }
  }
}

/* ------------------------------------------------------------------ *
 *  CONTROLLER LABELS — canvas-texture panels floating above each grip,
 *  showing a short description of that hand's controls at a glance.
 *  Attached to the grip objects so they track the physical controllers.
 * ------------------------------------------------------------------ */
function makeLabelTexture(lines, title) {
  const W = 480, H = 52 + lines.length * 80 + 24;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = 'rgba(8, 12, 20, 0.92)';
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 18);
  ctx.fill();

  // Border
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.4)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.roundRect(2, 2, W - 4, H - 4, 16);
  ctx.stroke();

  // Title
  ctx.fillStyle = '#7fd1ff';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, W / 2, 30);

  // Divider
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(20, 42);
  ctx.lineTo(W - 20, 42);
  ctx.stroke();

  // Each entry: key label on row 1, description indented on row 2
  lines.forEach(({ key, text }, i) => {
    const baseY = 58 + i * 80;

    // Key pill background
    ctx.fillStyle = 'rgba(120, 200, 255, 0.15)';
    ctx.beginPath();
    ctx.roundRect(14, baseY - 2, W - 28, 26, 6);
    ctx.fill();

    // Key name
    ctx.fillStyle = '#ffdd88';
    ctx.font = 'bold 17px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(key, 22, baseY + 17);

    // Description — smaller, below the key
    ctx.fillStyle = '#c8d8e8';
    ctx.font = '15px sans-serif';
    ctx.fillText(text, 22, baseY + 54);
  });

  return new THREE.CanvasTexture(canvas);
}

function setupControllerLabels() {
  const rightLines = [
    { key: 'THUMBSTICK', text: 'Move saucer Left · Right · Up · Down' },
    { key: 'A BUTTON',   text: 'Toggle saucer ON / OFF' },
    { key: 'B BUTTON',   text: 'Teleport into the bridge (again to return)' },
  ];

  const leftLines = [
    { key: 'THUMBSTICK', text: 'Move saucer Forward / Backward (Z)' },
    { key: 'TRIGGER',    text: 'Speed multiplier for Z movement' },
  ];

  const makePanel = (texture, w, h) => {
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    return new THREE.Mesh(geo, mat);
  };

  // Scale panel size proportional to canvas dimensions
  const rightTex = makeLabelTexture(rightLines, 'RIGHT CONTROLLER');
  const rightH = (52 + rightLines.length * 80 + 24) / 480;
  // Create label meshes now — they'll be attached to the correct physical
  // grip inside assignHandedness() once the controller handedness is known.
  rightLabelMesh = makePanel(rightTex, 0.22, 0.22 * rightH);
  rightLabelMesh.position.set(0, 0.09, -0.04);
  rightLabelMesh.rotation.x = -0.5;

  const leftTex = makeLabelTexture(leftLines, 'LEFT CONTROLLER');
  const leftH = (52 + leftLines.length * 80 + 24) / 480;
  leftLabelMesh = makePanel(leftTex, 0.22, 0.22 * leftH);
  leftLabelMesh.position.set(0, 0.09, -0.04);
  leftLabelMesh.rotation.x = -0.5;
}

/* ------------------------------------------------------------------ *
 *  PER-FRAME GAMEPAD POLLING (sticks + toggle button)
 *  Using the raw Gamepad API because XR "select" events only cover the
 *  primary trigger; sticks/buttons need direct polling every frame.
 * ------------------------------------------------------------------ */
function pollGamepads(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;

  let rightAxes = [0, 0, 0, 0];
  let leftAxes = [0, 0, 0, 0];
  let leftTriggerValue = 0;
  let toggleButtonPressed = false;
  let teleportButtonPressed = false;

  for (const source of session.inputSources) {
    if (!source.gamepad) continue;
    const gp = source.gamepad;

    if (source.handedness === 'right') {
      rightAxes = gp.axes.slice();
      // Button index 4 = A/X on Touch Plus controllers (toggle button).
      if (gp.buttons[4]) toggleButtonPressed = gp.buttons[4].pressed;
      // Button index 5 = B/Y — teleports the player to the saucer's locator.
      if (gp.buttons[5]) teleportButtonPressed = gp.buttons[5].pressed;
    } else if (source.handedness === 'left') {
      leftAxes = gp.axes.slice();
      // Button index 0 = trigger, used here as an accelerator (analog value).
      if (gp.buttons[0]) leftTriggerValue = gp.buttons[0].value;
    }
  }

  // Rising-edge: teleport once per physical press, not once per frame held.
  if (teleportButtonPressed && !prevTeleportButtonState) {
    teleportToJupiterLocator();
  }
  prevTeleportButtonState = teleportButtonPressed;

  // Rising-edge toggle: flip sphere state once per physical press.
  if (toggleButtonPressed && !prevButtonState) {
    setSphereOn(!sphereOn);
  }
  prevButtonState = toggleButtonPressed;

  // Touch controllers report thumbstick on axes[2] (x) / axes[3] (y).
  const rsx = applyDeadzone(rightAxes[2] ?? rightAxes[0] ?? 0);
  const rsy = applyDeadzone(rightAxes[3] ?? rightAxes[1] ?? 0);
  const lsy = applyDeadzone(leftAxes[3]  ?? leftAxes[1]  ?? 0);

  // The sphere only responds to movement input while it's switched On.
  if (sphereOn) {
    moveSphere(rsx, rsy, lsy, leftTriggerValue, dt);
  } else {
    dampSphereToRest(dt);
  }
}

function applyDeadzone(v) {
  return Math.abs(v) < STICK_DEADZONE ? 0 : v;
}

/* ------------------------------------------------------------------ *
 *  TELEPORT — B/Y button jumps the player to the saucer's bridge, at
 *  its "teleport_locator" node, wherever the saucer currently is
 *  (including mid-flight). Pressing it again returns the player to
 *  normal scale at the room's origin, so nobody gets stuck tiny.
 *
 *  Moving AND scaling the player rig (rather than just moving it) is
 *  what makes the bridge — a one-person cockpit that's still small even
 *  at the saucer's realistic size — feel properly roomy: the player is
 *  shrunk by teleportPlayerScale (derived from the bridge's real size,
 *  see setupSphere), so their real, room-scale movements read as
 *  correctly-scaled movement inside the tiny cabin.
 *
 *  The initial jump only sets the rig's position once; staying glued to
 *  the saucer as it flies around is handled every frame afterward by
 *  updateTeleportFollow(), below.
 * ------------------------------------------------------------------ */
function teleportToJupiterLocator() {
  if (isTeleportedToBridge) {
    // Return to normal scale at the play area's origin.
    playerRig.position.set(0, 0, 0);
    playerRig.scale.setScalar(1);
    isTeleportedToBridge = false;
    return;
  }

  if (!jupiterLocatorNode) return;

  const target = jupiterLocatorNode.getWorldPosition(new THREE.Vector3());
  playerRig.position.copy(target);
  playerRig.scale.setScalar(teleportPlayerScale);
  isTeleportedToBridge = true;
}

// Called every frame: while the player is inside the bridge, re-anchor
// the rig to the locator's CURRENT world position, so riding along in
// the moving saucer feels like standing on solid (moving) ground rather
// than being left behind in empty space as it flies off.
function updateTeleportFollow() {
  if (!isTeleportedToBridge || !jupiterLocatorNode) return;
  jupiterLocatorNode.getWorldPosition(playerRig.position);
}

/* ------------------------------------------------------------------ *
 *  SPHERE MOVEMENT
 *  Right stick: forward/back -> Y (up/down), left/right -> X
 *  Left stick:  forward/back -> Z, scaled by left trigger accelerator
 *  Physics (gravity, collisions) still acts on the body at all times —
 *  this just layers direct velocity control on top, like a thruster.
 * ------------------------------------------------------------------ */
function moveSphere(rsx, rsy, lsy, leftTrigger, dt) {
  const vel = sphereBody.linvel();
  let vx = vel.x;
  let vy = vel.y;
  let vz = vel.z;

  // Right stick X -> world X. Right stick Y (pushed forward = negative on
  // XR gamepads) -> world Y, so "forward" raises the sphere.
  if (rsx !== 0) vx = rsx * SPHERE_MOVE_SPEED;
  else vx = THREE.MathUtils.damp(vx, 0, 6, dt);

  // When the stick is idle, leave Y untouched so gravity (and floor
  // contact) keeps governing vertical motion naturally.
  if (rsy !== 0) vy = -rsy * SPHERE_MOVE_SPEED;

  // Left stick Y -> world Z, multiplied by the left trigger accelerator.
  const accel = 1.0 + leftTrigger * Z_ACCEL_MULTIPLIER;
  if (lsy !== 0) vz = -lsy * Z_BASE_SPEED * accel;
  else vz = THREE.MathUtils.damp(vz, 0, 6, dt);

  sphereBody.setLinvel({ x: vx, y: vy, z: vz }, true);
  sphereBody.wakeUp();
}

/* ------------------------------------------------------------------ *
 *  While the sphere is Off, ignore stick input entirely (per spec) but
 *  still let gravity/friction settle it naturally on the floor — we just
 *  bleed off any lateral momentum so it doesn't drift once switched off
 *  mid-motion.
 * ------------------------------------------------------------------ */
function dampSphereToRest(dt) {
  const vel = sphereBody.linvel();
  const vx = THREE.MathUtils.damp(vel.x, 0, 6, dt);
  const vz = THREE.MathUtils.damp(vel.z, 0, 6, dt);
  sphereBody.setLinvel({ x: vx, y: vel.y, z: vz }, true);
}

/* ------------------------------------------------------------------ *
 *  PHYSICS STEP — fixed substeps for stability regardless of XR frame
 *  rate (Quest 3 can run 72 / 90 / 120 Hz).
 * ------------------------------------------------------------------ */
function stepPhysics(dt) {
  physicsAccumulator += dt;
  let steps = 0;
  while (physicsAccumulator >= FIXED_TIMESTEP && steps < MAX_SUBSTEPS) {
    world.step();
    physicsAccumulator -= FIXED_TIMESTEP;
    steps++;
  }
}

/* ------------------------------------------------------------------ *
 *  SYNC: Rapier rigid bodies -> Three.js meshes
 * ------------------------------------------------------------------ */
function syncMeshes() {
  const sp = sphereBody.translation();
  const sq = sphereBody.rotation();
  sphereMesh.position.set(sp.x, sp.y, sp.z);
  sphereMesh.quaternion.set(sq.x, sq.y, sq.z, sq.w);
}

/* ------------------------------------------------------------------ *
 *  LUMINOUS GLOW WHILE AIRBORNE
 *  The further Jupiter2 lifts off the floor, the brighter its emissive
 *  and internal point light — a "white bloom" take-off effect.
 * ------------------------------------------------------------------ */
function updateSphereGlow(dt) {
  const heightAboveFloor = Math.max(0, sphereMesh.position.y - SPHERE_RADIUS);
  const targetFactor = THREE.MathUtils.clamp(heightAboveFloor / GLOW_HEIGHT_RANGE, 0, 1);

  const current = sphereMesh.userData.glowFactor ?? 0;
  const factor = THREE.MathUtils.damp(current, targetFactor, GLOW_LERP_SPEED, dt);
  sphereMesh.userData.glowFactor = factor;

  // Base emissive when ON is warm white; ramp to pure white bloom at altitude.
  const baseEmissive = new THREE.Color(sphereOn ? 0x888888 : 0x000000);
  const glowColor = new THREE.Color(GLOW_COLOR); // 0xffffff
  const blended = baseEmissive.clone().lerp(glowColor, factor);
  const intensity = (sphereOn ? 1.0 : 0.0) + factor * GLOW_MAX_EMISSIVE;

  sphereMaterials.forEach((m) => {
    if (m.emissive) m.emissive.copy(blended);
    if ('emissiveIntensity' in m) m.emissiveIntensity = intensity;
  });

  sphereGlowLight.intensity = factor * GLOW_MAX_LIGHT_INTENSITY;

  // bulb1 upper dome glows white, brightening with altitude.
  const domeIntensity = (sphereOn ? 0.15 : 0) + factor * 0.4;
  bulbMaterials.forEach((m) => {
    if (m.emissive) m.emissive.setHex(0xffffff);
    if ('emissiveIntensity' in m) m.emissiveIntensity = domeIntensity;
  });

  // Windows stay pure black — never affected by any bloom pass.
  windowMaterials.forEach((m) => {
    m.color.setHex(0x000000);
    m.emissive.setHex(0x000000);
    m.emissiveIntensity = 0;
  });

  if (engineSound) engineSound.setAltitudeFactor(factor);
}

/* ------------------------------------------------------------------ *
 *  FLASH LIGHTS — the flashLights node spins on world Z (found by
 *  trial and error — X and Y didn't match the model) and pulses a
 *  white emissive glow + point light. Base speed is 0.9 rad/s at
 *  ground level; altitude factor adds up to 3× on top as the saucer
 *  climbs. rotateOnWorldAxis guarantees a consistent world-space spin
 *  regardless of local coordinate transforms baked into the GLB
 *  hierarchy.
 * ------------------------------------------------------------------ */
const FLASH_BASE_SPEED   = 0.9;
const FLASH_ALTITUDE_AMP = 2.7;
const FLASH_PULSE_SPEED  = 7.0;
const WORLD_Y = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);
const WORLD_Z = new THREE.Vector3(0, 0, 1);

function updateFlashingLights(dt, elapsed) {
  if (!flashLightsNode) return;

  if (!sphereOn) {
    if (flashLightsLight) flashLightsLight.intensity = 0;
    flashLightsNode.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => { if (m) m.emissiveIntensity = 0; });
    });
    return;
  }

  // Corkscrew spin around world Z — X and Y didn't produce the right
  // visible spin in practice; Z is what actually matches the model.
  const altFactor = sphereMesh.userData.glowFactor ?? 0;
  const speed = FLASH_BASE_SPEED + altFactor * FLASH_ALTITUDE_AMP;
  flashLightsNode.rotateOnWorldAxis(WORLD_Z, speed * dt);

  // Pulsing white emissive on the mesh geometry itself.
  const pulse = 1.2 + 0.8 * Math.sin(elapsed * FLASH_PULSE_SPEED);
  flashLightsNode.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach((m) => { if (m) m.emissiveIntensity = pulse; });
  });

  if (flashLightsLight) {
    flashLightsLight.intensity = 0.6 + 0.8 * Math.abs(Math.sin(elapsed * FLASH_PULSE_SPEED * 0.5));
  }
}

/* ------------------------------------------------------------------ *
 *  MAIN LOOP
 * ------------------------------------------------------------------ */
function renderLoop() {
  const dt = Math.min(clock.getDelta(), 1 / 30); // clamp to avoid huge steps on hiccups
  const elapsed = clock.getElapsedTime();

  if (renderer.xr.isPresenting) {
    pollGamepads(dt);
  }

  stepPhysics(dt);
  syncMeshes();
  updateTeleportFollow();
  updateSphereGlow(dt);
  updateFlashingLights(dt, elapsed);
  updateStarfield(elapsed);
  updateGalaxy(dt, elapsed);

  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}