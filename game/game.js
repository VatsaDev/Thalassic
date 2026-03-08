import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise2D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SpellRegistry, updateSpells, activeSpells } from './spells.js';

const classSpells = {
    0: ["BLOOD DRAIN", "CRIMSON SPIKES", "VAMPIRIC SWARM"],
    1: ["THORN WHIP", "ENTANGLE", "NATURE'S WRATH"],
    2: ["GALE BLAST", "TORNADO", "WIND SHEAR"],
    3: ["WATER BALL", "FROST NOVA", "TSUNAMI"],
    4: ["ARCANE MISSILES", "MANA RIFT", "MAGIC BURST"],
    5: ["FIREBALL", "FLAME BREATH", "FIRE SPEARS"]
};

/**
 * ============================================================================
 * 1. INITIALIZATION & GLOBAL SETTINGS
 * ============================================================================
 */
const SERVER_URL = window.location.origin;
// Extract the username and skin from query parameters, if available
const urlParams = new URLSearchParams(window.location.search);
const username = urlParams.get('username') || "Guest";
const skinString = urlParams.get('skin') || "0";
const skinId = parseInt(skinString, 10);

const socket = io(SERVER_URL, {
    autoConnect: false,
    query: { username: username, skin: skinId }
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 20000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const clock = new THREE.Clock();

let noise2D; // Initialized later with seed
let pseudoRandom; // Our seeded PRNG

function startSeededWorld(seed) {
    // Basic Mulberry32 PRNG
    pseudoRandom = function() {
        var t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    noise2D = createNoise2D(pseudoRandom);
}

function seededRandom(s) {
    const x = Math.sin(s) * 10000;
    return x - Math.floor(x);
}

const wizardModels = [];
const modelFiles = [
    'assets/wizord_red.glb',    // 0: FIRE
    'assets/wizord_green.glb',  // 1: NATURE
    'assets/wizord_sky.glb',    // 2: WIND
    'assets/wizord_blu.glb',    // 3: WATER
    'assets/wizord_purp.glb',   // 4: ARCANE
    'assets/wizord_orang.glb'   // 5: BLOOD
];

/**
 * ============================================================================
 * 2. TERRAIN ENGINE (10KM WORLD, 1.5KM EVEREST PEAKS)
 * ============================================================================
 */
const WORLD_SIZE = 10000;
const CHUNKS_SIDE = 8; // 8x8 grid = 64 chunks
const CHUNK_SIZE = WORLD_SIZE / CHUNKS_SIDE; // 1250 units per chunk
const SEGMENTS = 128; // Vertex density per chunk

function getTerrainHeight(x, z) {
    // 1. Calculate World Radius Mask (Valley at 0,0 - Everest at edges)
    const dist = Math.sqrt(x * x + z * z);
    const maxDist = WORLD_SIZE / 2;
    const mask = Math.pow(Math.min(1.0, dist / (maxDist * 0.9)), 2.5); // Smoother exponential curve

    // 2. FBM Noise (Fractal Brownian Motion)
    let h = 0;
    let amp = 1;
    let freq = 0.0005; // Wide features
    for (let i = 0; i < 6; i++) {
        // Derivative-style ridge noise for sharp peaks
        let n = 1.0 - Math.abs(noise2D(x * freq, z * freq));
        h += Math.pow(n, 2.0) * amp;
        freq *= 2.2;
        amp *= 0.45;
    }

    // 3. Final Scale: Max peaks ~1500m
    return mask * (h * 1500);
}

/**
 * ============================================================================
 * 3. SHADERS (WINDY FOLIAGE SYSTEM)
 * ============================================================================
 */

const foliageUniforms = {
    time: { value: 0 },
    swayStrength: { value: 0.2 },
    sunDir: { value: new THREE.Vector3(1, 1, 1).normalize() }
};

const foliageVertexShader = `
    varying vec2 vUv;
    varying vec3 vNormal;
    uniform float time;
    uniform float swayStrength;

    void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);
        
        vec4 worldInstance = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec3 pos = position;

        // Windy Sway: Use world X/Z to offset wind phase so they don't move in unison
        float windPhase = worldInstance.x * 0.1 + worldInstance.z * 0.1;
        float wind = sin(time * 2.0 + windPhase) * swayStrength;
        
        // Only sway the tops (tapered tips)
        // pos.y is height. We sway more as y increases.
        float influence = pow(max(0.0, pos.y), 1.5);
        pos.x += wind * influence;
        pos.z += wind * influence * 0.5;

        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
    }
`;

const foliageFragmentShader = `
    varying vec2 vUv;
    varying vec3 vNormal;
    uniform vec3 diffuse;

    void main() {
        // Simple Top-Down Shading
        float dotProduct = dot(vNormal, vec3(0.0, 1.0, 0.0));
        vec3 color = mix(diffuse * 0.6, diffuse, dotProduct);
        gl_FragColor = vec4(color, 1.0);
    }
`;

/**
 * ============================================================================
 * 4. FOLIAGE ASSETS (TAPERED GRASS & PINE TREES)
 * ============================================================================
 */

// 1. Tapered Grass Geometry (A 3D "Blade" made of triangles)

function colorGeo(geo, colorHex) {
    const count = geo.attributes.position.count;
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color(colorHex);
    for (let i = 0; i < count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geo;
}

function createGrassGeometry() {
    const geometries = [];
    for (let i = 0; i < 100; i++) {
        const w = 0.5 + Math.random() * 0.2, h = 10.0; // thicker
        const geo = new THREE.BufferGeometry();
        const verts = new Float32Array([-w, 0, 0, w, 0, 0, 0, h, 0, 0, 0, -w, 0, 0, w, 0, h, 0]);
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));

        // Randomly scatter blades within a spread of 7.0 multiplier radius
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.sqrt(Math.random()) * 7.0;
        geo.rotateY(Math.random());
        geo.translate(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
        geometries.push(colorGeo(geo, 0x3a6b32));
    }
    return mergeGeometries(geometries);
}

function createPineGeometry() {
    // 1. Trunk
    let trunk = new THREE.CylinderGeometry(0.4, 0.6, 4, 6);
    trunk.translate(0, 2, 0);
    colorGeo(trunk, 0x4d2911); // Brown

    // 2. Leaves (3 layers)
    const tiers = [trunk];
    for (let i = 0; i < 3; i++) {
        let cone = new THREE.ConeGeometry(3.5 - (i * 0.8), 5, 8);
        cone.translate(0, 5 + (i * 3), 0);
        colorGeo(cone, 0x1a331a); // Dark Green
        tiers.push(cone);
    }

    // Merge and make "Low Poly" (Faceted)
    return mergeGeometries(tiers).toNonIndexed();
}

const foliageMaterial = new THREE.MeshPhongMaterial({
    vertexColors: true,
    flatShading: true,
    shininess: 0
});

// We store the shader here so we can update time in the loop
let foliageShader = null;

foliageMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.time = { value: 0 };
    foliageShader = shader;
    shader.vertexShader = `
        uniform float time;
        ${shader.vertexShader}
    `.replace(
        `#include <begin_vertex>`,
        `
        #include <begin_vertex>
        // Only sway based on height (position.y)
        float sway = sin(time * 2.0 + position.x * 0.5) * (transformed.y * 0.05);
        transformed.x += sway;
        transformed.z += sway;
        `
    );
};

// Use this for both
const grassMat = foliageMaterial;
const pineMat = foliageMaterial;

/**
 * ============================================================================
 * 5. WORLD GENERATION & CHUNKING
 * ============================================================================
 */
function createChunk(xOffset, zOffset) {
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    const grassMatrices = [];
    const treeMatrices = [];
    const dummy = new THREE.Object3D();

    const massiveTreeWorldX = 500; // Change these to your desired world location
    const massiveTreeWorldZ = 500;

    let massiveTreePlacedInThisChunk = false;

    for (let i = 0; i < pos.count; i++) {
        const localX = pos.getX(i);
        const localZ = pos.getZ(i);

        const worldX = localX + xOffset;
        const worldZ = localZ + zOffset;
        const y = getTerrainHeight(worldX, worldZ);

        // Apply height and color
        pos.setY(i, y);
        const color = new THREE.Color();
        if (y > 1000) color.setHex(0xffffff);
        else if (y > 400) color.setHex(0x555555);
        else color.setHex(0x2d5a27);

        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;

        // --- 2. UNIQUE MASSIVE TREE LOGIC ---
        // We check if the current vertex is the closest one to our target coordinates
        // and ensure we only place it once per chunk (in case multiple vertices are close).
        const distanceToTarget = Math.sqrt(Math.pow(worldX - massiveTreeWorldX, 2) + Math.pow(worldZ - massiveTreeWorldZ, 2));

        // If we are within 5 units of the target and haven't placed it yet
        if (distanceToTarget < 5 && !massiveTreePlacedInThisChunk) {
            dummy.position.set(localX, y, localZ);
            const massiveScale = 250.0; // The "Massive" part
            dummy.scale.set(massiveScale, massiveScale, massiveScale);
            dummy.rotation.y = 0;
            dummy.updateMatrix();
            treeMatrices.push(dummy.matrix.clone());

            massiveTreePlacedInThisChunk = true; // Prevents duplicate placement in this chunk
        }

        // --- 3. REGULAR VEGETATION (Probability-based) ---
        const seed = worldX * 12.9898 + worldZ * 78.233;
        const rand = seededRandom(seed);

        if (y < 200 && i % 15 === 0) {
            if (rand > 0.98) {
                dummy.position.set(localX, y, localZ);
                const scale = 1.0 + pseudoRandom() * 10.0;
                dummy.scale.set(scale, scale, scale);
                dummy.rotation.y = pseudoRandom() * Math.PI;
                dummy.updateMatrix();
                treeMatrices.push(dummy.matrix.clone());
            } else if (rand > 0.8) {
                dummy.position.set(localX, y, localZ);
                dummy.scale.setScalar(0.8 + pseudoRandom() * 0.5);
                dummy.rotation.y = pseudoRandom() * Math.PI;
                dummy.updateMatrix();
                grassMatrices.push(dummy.matrix.clone());
            }
        }
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const group = new THREE.Group();
    // Move the whole group to the chunk's world position
    group.position.set(xOffset, 0, zOffset);

    const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.8,
        flatShading: true
    }));
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    group.add(terrain);

    if (grassMatrices.length > 0) {
        const grass = new THREE.InstancedMesh(createGrassGeometry(), grassMat, grassMatrices.length);
        for (let j = 0; j < grassMatrices.length; j++) grass.setMatrixAt(j, grassMatrices[j]);
        grass.castShadow = true;
        grass.receiveShadow = true;
        group.add(grass);
    }

    if (treeMatrices.length > 0) {
        const trees = new THREE.InstancedMesh(createPineGeometry(), pineMat, treeMatrices.length);
        for (let j = 0; j < treeMatrices.length; j++) trees.setMatrixAt(j, treeMatrices[j]);
        trees.castShadow = true;
        trees.receiveShadow = true;
        group.add(trees);
    }

    return group;
}

function initWorld(treeModel, bushModel, shroomModel, carpModel) {
    // Generate the grid
    for (let x = -4; x < 4; x++) {
        for (let z = -4; z < 4; z++) {
            scene.add(createChunk(x * CHUNK_SIZE + CHUNK_SIZE / 2, z * CHUNK_SIZE + CHUNK_SIZE / 2));
        }
    }

    const treeBoxes = [];
    const bushBoxes = [];

    // Spawn Props based on the synchronized noise map
    for(let i=0; i<60; i++) {
        const x = (pseudoRandom()-0.5)*2000;
        const z = (pseudoRandom()-0.5)*2000;
        const y = getTerrainHeight(x, z);
        const m = (i < 20 ? treeModel : bushModel).clone();
        m.position.set(x, y, z);
        m.scale.setScalar(i < 20 ? 8 : 4);
        m.rotation.y = pseudoRandom() * Math.PI * 2;
        scene.add(m);

        // Add to collision/distance boxes for mana regen
        const box = new THREE.Box3().setFromObject(m);
        if (i < 20) treeBoxes.push(box);
        else bushBoxes.push(box);
    }
    
    // Attach them to window to access in animate
    window.treeBoxes = treeBoxes;
    window.bushBoxes = bushBoxes;

    for(let i=0; i<40; i++) {
        let x, z, y;
        for(let a=0; a<100; a++) {
            x = (pseudoRandom()-0.5)*8000;
            z = (pseudoRandom()-0.5)*8000;
            y = getTerrainHeight(x, z);
            if(y > 400) break;
        }
        if(y > 400) {
            const m = shroomModel.clone();
            m.position.set(x, y, z);
            m.scale.setScalar(3);
            m.rotation.y = pseudoRandom() * Math.PI * 2;
            m.uuid_obj = m; 
            scene.add(m);
            const box = new THREE.Box3().setFromObject(m);
            box.uuid_obj = m;
            shroomBoxes.push(box);
        }
    }

    for(let i=0; i<3; i++) {
        const m = carpModel.clone();
        m.scale.setScalar(8);
        scene.add(m);
        carpets.push({ mesh: m, angle: pseudoRandom() * Math.PI * 2, radius: 200 + pseudoRandom() * 100 });
    }
}

/**
 * ============================================================================
 * 6. LIGHTING, SKY & ATMOSPHERE
 * ============================================================================
 */
scene.background = new THREE.Color(0xaaccff);
scene.fog = new THREE.FogExp2(0xaaccff, 0.0002);

const sun = new THREE.DirectionalLight(0xfff5e6, 1.5);
sun.position.set(1000, 2000, 1000);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -3000; sun.shadow.camera.right = 3000;
sun.shadow.camera.top = 3000; sun.shadow.camera.bottom = -3000;
sun.shadow.camera.far = 10000;
sun.shadow.bias = -0.0001;
scene.add(sun);

// The Visible Sun
const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(60, 32, 32), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
sunMesh.position.copy(sun.position).normalize().multiplyScalar(5000);
scene.add(sunMesh);

scene.add(new THREE.AmbientLight(0xffffff, 0.5));

// Wind Particle System
const windParticles = [];
for (let i = 0; i < 600; i++) {
    const geo = new THREE.PlaneGeometry(30, 0.5); // Much longer and thicker
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
    const p = new THREE.Mesh(geo, mat);
    // Allow spawning anywhere from Y: 50 up to Y: 1500, but in a much wider radius so it feels like a global weather effect
    p.position.set((Math.random() - 0.5) * 8000, 50 + Math.random() * 1450, (Math.random() - 0.5) * 8000);
    p.userData = { speed: Math.random() * 4.0 + 2.0 }; // Faster wind
    scene.add(p);
    windParticles.push(p);
}

const shroomBoxes = [];
let carpets = [];

/**
 * ============================================================================
 * 7. CHARACTER CONTROLLER & PHYSICS
 * ============================================================================
 */
const players = {};
let myMesh = null;
let matchEndTime = null;
const bloodSplatters = []; // persistent blood on ground
const myKD = { kills: 0, deaths: 0 };

// Debug Hitbox Helpers
const playerHitboxHelpers = {};
const spellHitboxHelpers = new Map();

const state = {
    x: 50, y: 100, z: -50, // Spawn high
    yVel: 0,
    yaw: 0, pitch: 0,
    zoom: 40,
    isGrounded: false, jumpCount: 0,
    dashVel: { x: 0, z: 0 },
    lastDash: 0,
    shroomBuff: false,
    mana: 75,
    activeSpellIndex: 0,
    lastCastTime: 0,
    speedMultiplier: 1.0,
    isDead: false
};

function createPlayerMesh(data) {
    const group = new THREE.Group();
    group.hp = data.hp !== undefined ? data.hp : 100;

    if (wizardModels.length > 0) {
        // Use the skinId sent from the server or default to 0
        const skinIdParam = data.skinId !== undefined ? data.skinId : 0;
        const modelIndex = skinIdParam % wizardModels.length;

        const wizard = wizardModels[modelIndex].clone();

        // Adjust scale/rotation if your models come in sideways or tiny
        wizard.scale.set(2, 2, 2);
        wizard.rotation.y = -2 * Math.PI; // Face forward (neg fixes direction)

        group.add(wizard);
    } else {
        // Fallback cube if loader fails
        console.log("FALLBACK FALLBACK")
        console.log(wizardModels)
        const cube = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), new THREE.MeshStandardMaterial({ color: data.color }));
        cube.castShadow = true;
        group.add(cube);
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 512; canvas.height = 128;
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.roundRect(0, 0, 512, 128, 20); ctx.fill();
    ctx.font = "bold 60px Arial"; ctx.fillStyle = "white"; ctx.textAlign = "center";
    ctx.fillText(data.name, 256, 85);

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));

    sprite.scale.set(10, 2.5, 1);
    sprite.position.y = 8;

    group.add(sprite);
    return group;
}

const particles = [];
function createPoof() {
    for (let i = 0; i < 15; i++) {
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.8, 0.8, 0.8),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 })
        );
        mesh.position.set(state.x + (Math.random() - 0.5) * 3, state.y - 1, state.z + (Math.random() - 0.5) * 3);
        mesh.userData = {
            vx: (Math.random() - 0.5) * 0.8,
            vy: Math.random() * 0.5 + 0.2,
            vz: (Math.random() - 0.5) * 0.8,
            life: 1.0
        };
        scene.add(mesh);
        particles.push(mesh);
    }
}

// Blood explosion on death — burst of red particles
function createBloodExplosion(position) {
    for (let i = 0; i < 50; i++) {
        const size = 0.5 + Math.random() * 1.5;
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(size, size, size),
            new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(0, 1, 0.1 + Math.random() * 0.3), transparent: true, opacity: 1 })
        );
        mesh.position.copy(position).add(new THREE.Vector3((Math.random()-0.5)*3, Math.random()*4, (Math.random()-0.5)*3));
        mesh.userData = {
            vx: (Math.random() - 0.5) * 4,
            vy: Math.random() * 5 + 2,
            vz: (Math.random() - 0.5) * 4,
            life: 1.5 + Math.random() * 1.0,
            gravity: -0.15
        };
        scene.add(mesh);
        particles.push(mesh);
    }
}

// Persistent blood splatter on ground
function createBloodSplatter(position) {
    const groundY = getTerrainHeight(position.x, position.z) + 0.15;
    for (let i = 0; i < 8; i++) {
        const radius = 1.5 + Math.random() * 4;
        const geo = new THREE.CircleGeometry(radius, 12);
        const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color().setHSL(0, 1, 0.05 + Math.random() * 0.1),
            transparent: true,
            opacity: 0.8 + Math.random() * 0.2,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const splat = new THREE.Mesh(geo, mat);
        splat.rotation.x = -Math.PI / 2;
        splat.position.set(
            position.x + (Math.random() - 0.5) * 10,
            groundY,
            position.z + (Math.random() - 0.5) * 10
        );
        splat.rotation.z = Math.random() * Math.PI * 2;
        scene.add(splat);
        bloodSplatters.push(splat); // persist forever
    }
}

function updateKDDisplay() {
    const ratio = myKD.deaths === 0 ? myKD.kills.toFixed(1) : (myKD.kills / myKD.deaths).toFixed(2);
    const el = document.getElementById('kd-text');
    if (el) el.innerText = `K: ${myKD.kills}  D: ${myKD.deaths}  KD: ${ratio}`;
}

// Controls
const keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space') {
        if (state.isGrounded) {
            state.yVel = 4.8; // 3x Jump force
            state.jumpCount = 1;
            state.isGrounded = false;
            createPoof();
        } else if (state.jumpCount < 2) {
            state.yVel = 4.8; // SAME HEIGHT DOUBLE JUMP
            state.jumpCount = 2;
            createPoof();
        }
    }
    if (e.code === 'KeyQ' && Date.now() - state.lastDash > 500) {
        state.dashVel.x = -Math.sin(state.yaw) * 15;
        state.dashVel.z = -Math.cos(state.yaw) * 15;
        state.lastDash = Date.now();
    }
});
window.addEventListener('keyup', (e) => keys[e.code] = false);

// Spell Selection logic
function updateHotbarUI() {
    const mySpells = classSpells[skinId];
    for (let i = 0; i < 3; i++) {
        const slot = document.getElementById(`slot-${i}`);
        const nameSpan = document.getElementById(`spell-name-${i}`);
        if (slot && nameSpan && mySpells) {
            nameSpan.innerText = mySpells[i] || "";
            if (state.activeSpellIndex === i) {
                slot.classList.add('active');
            } else {
                slot.classList.remove('active');
            }
        }
    }
}

// UI Click listeners for hotbar
for(let i=0; i<3; i++) {
    const slot = document.getElementById(`slot-${i}`);
    if(slot) {
        slot.addEventListener('click', (e) => {
            e.stopPropagation();
            state.activeSpellIndex = i;
            updateHotbarUI();
        });
    }
}

window.addEventListener('keydown', (e) => {
    if (e.code === 'Digit1') { state.activeSpellIndex = 0; updateHotbarUI(); }
    if (e.code === 'Digit2') { state.activeSpellIndex = 1; updateHotbarUI(); }
    if (e.code === 'Digit3') { state.activeSpellIndex = 2; updateHotbarUI(); }
});

// Camera Look & Combat
document.addEventListener('click', (e) => {
    // Prevent double-firing if clicking a slot
    if (e.target.closest('.spell-slot')) return;

    if (!document.pointerLockElement) {
        document.body.requestPointerLock();
    } else {
        // Cast Spell
        const mySpells = classSpells[skinId];
        if(!mySpells) return;

        const spellName = mySpells[state.activeSpellIndex];
        const spellDef = SpellRegistry[spellName];
        
        if (spellDef) {
            const now = clock.getElapsedTime();
            if (now - state.lastCastTime >= spellDef.cooldown && state.mana >= spellDef.cost) { 
                // Determine cast position & direction
                const castPos = new THREE.Vector3(state.x, state.y + 2, state.z);
                const castDir = new THREE.Vector3();
                camera.getWorldDirection(castDir);

                const startIdx = activeSpells.length;
                // Add slight upward bias to avoid floor clipping
                const castDirBiased = castDir.clone().add(new THREE.Vector3(0, 0.05, 0)).normalize();
                spellDef.cast(scene, castPos, castDirBiased, socket.id);
                state.mana -= spellDef.cost;
                state.lastCastTime = now;

                // Tag newly created spells as ours
                for (let i = startIdx; i < activeSpells.length; i++) {
                    activeSpells[i].ownerId = socket.id;
                    activeSpells[i].spellName = spellName;
                }

                // NETWORK: Notify server of the spell cast
                socket.emit('castSpell', {
                    pos: { x: castPos.x, y: castPos.y, z: castPos.z },
                    dir: { x: castDir.x, y: castDir.y, z: castDir.z },
                    spellName: spellName,
                    skinId: skinId
                });
            }
        }
    }
});
document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement) {
        state.yaw -= e.movementX * 0.002;
        state.pitch -= e.movementY * 0.002;
        state.pitch = Math.max(-1.4, Math.min(1.4, state.pitch));
    }
});

/**
 * ============================================================================
 * 8. NETWORK SYNC
 * ============================================================================
 */

function initSocket() {
    socket.on('currentPlayers', (srv) => {
        Object.keys(srv).forEach(id => {
            if (!players[id]) {
                // Pass the ID explicitly so the model selection math works
                players[id] = createPlayerMesh({ ...srv[id], id: id });
                scene.add(players[id]);
                if (id === socket.id) myMesh = players[id];
            }
        });
    });

    socket.on('newPlayer', (d) => {
        players[d.id] = createPlayerMesh({ ...d.player, id: d.id });
        scene.add(players[d.id]);
        
        // Add debug hitbox wireframe
        const geo = new THREE.BoxGeometry(8, 14, 8);
        const mat = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true, transparent: true, opacity: 0.5 });
        const helper = new THREE.Mesh(geo, mat);
        scene.add(helper);
        playerHitboxHelpers[d.id] = helper;
    });

    socket.on('playerMoved', (d) => {
        if (players[d.id] && d.id !== socket.id) {
            players[d.id].position.set(d.x, d.y, d.z);
            if (playerHitboxHelpers[d.id]) {
                playerHitboxHelpers[d.id].position.set(d.x, d.y + 7, d.z);
            }
        }
    });

    socket.on('playerDisconnected', (id) => {
        if (players[id]) {
            scene.remove(players[id]);
            delete players[id];
        }
        if (playerHitboxHelpers[id]) {
            scene.remove(playerHitboxHelpers[id]);
            delete playerHitboxHelpers[id];
        }
    });

    socket.on('opponentSpell', (d) => {
        // Render visuals for another player's spell
        const spellDef = SpellRegistry[d.spellName];
        if (spellDef) {
            const castPos = new THREE.Vector3(d.pos.x, d.pos.y, d.pos.z);
            const castDir = new THREE.Vector3(d.dir.x, d.dir.y, d.dir.z);
            
            const startIdx = activeSpells.length;
            spellDef.cast(scene, castPos, castDir, d.id);
            
            // Tag with opponent ID so we don't accidentally report their hits
            for (let i = startIdx; i < activeSpells.length; i++) {
                activeSpells[i].ownerId = d.id;
                activeSpells[i].spellName = d.spellName;
            }
        }
    });

    socket.on('hpUpdate', (d) => {
        if (players[d.id]) {
            players[d.id].hp = d.hp;
        }
    });

    socket.on('playerDied', (d) => {
        const deathPos = new THREE.Vector3(d.x, d.y, d.z);
        createBloodExplosion(deathPos);
        createBloodSplatter(deathPos);
        
        // Hide the dead player's mesh
        if (players[d.id]) {
            players[d.id].visible = false;
        }
        
        // If it's us, mark dead
        if (d.id === socket.id) {
            state.isDead = true;
        }
    });

    socket.on('playerRespawn', (d) => {
        if (players[d.id]) {
            players[d.id].visible = true;
            players[d.id].hp = d.hp;
            players[d.id].position.set(d.x, d.y, d.z);
        }
        
        // If it's us, respawn
        if (d.id === socket.id) {
            state.isDead = false;
            state.x = d.x;
            state.y = d.y;
            state.z = d.z;
            state.yVel = 0;
        }
    });

    socket.on('kdUpdate', (d) => {
        if (d.id === socket.id) {
            myKD.kills = d.kills;
            myKD.deaths = d.deaths;
            updateKDDisplay();
        }
    });

    socket.on('applyEffect', (d) => {
        if (d.effect === 'root') {
            state.speedMultiplier = 0;
            setTimeout(() => {
                state.speedMultiplier = 1.0;
            }, (d.duration || 2) * 1000);
        }
    });

    socket.on('matchInfo', (info) => {
        matchEndTime = info.endTime;
    });

    socket.on('matchEnded', () => {
        window.location.href = 'index.html';
    });
}

/**
 * ============================================================================
 * 9. MAIN GAME LOOP
 * ============================================================================
 */
function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();
    const totalTime = clock.getElapsedTime();

    if (foliageShader) {
        foliageShader.uniforms.time.value = totalTime;
    }

    // Process Active Spells
    updateSpells(dt, scene, players);

    // Update Player Hitbox Helpers (including our own)
    Object.keys(players).forEach(id => {
        if (playerHitboxHelpers[id]) {
            playerHitboxHelpers[id].position.copy(players[id].position).add(new THREE.Vector3(0, 7, 0));
        } else {
            // Create helper if it doesn't exist (e.g. for existing players on join or local player)
            const geo = new THREE.BoxGeometry(8, 14, 8);
            const mat = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true, transparent: true, opacity: 0.5 });
            const helper = new THREE.Mesh(geo, mat);
            scene.add(helper);
            playerHitboxHelpers[id] = helper;
        }
    });

    // Update Spell Hitbox Helpers
    activeSpells.forEach(spell => {
        if (!spell.mesh) return;

        let helper = spellHitboxHelpers.get(spell);
        if (!helper) {
            if (spell.type === "box") {
                const size = spell.size || new THREE.Vector3(10, 10, 10);
                const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
                const mat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.5 });
                helper = new THREE.Mesh(geo, mat);
            } else {
                const radius = spell.radius || 5.5;
                const geo = new THREE.SphereGeometry(radius, 8, 8);
                const mat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.5 });
                helper = new THREE.Mesh(geo, mat);
            }
            scene.add(helper);
            spellHitboxHelpers.set(spell, helper);
        }

        // Sync helper position
        helper.position.copy(spell.mesh.position);
        if (spell.type === "box") {
            helper.rotation.copy(spell.mesh.rotation);
        }
    });

    // Remove helpers for dead spells
    for (const [spell, helper] of spellHitboxHelpers.entries()) {
        if (!activeSpells.includes(spell)) {
            scene.remove(helper);
            spellHitboxHelpers.delete(spell);
        }
    }
    
    // ----------------------------------------------------------------------------
    // PHYSICS: Tornado Pull/Fling & Other Effects
    // ----------------------------------------------------------------------------
    const myPos = new THREE.Vector3(state.x, state.y, state.z);
    activeSpells.forEach(spell => {
        if (spell.physics === "tornado") {
            const dist = myPos.distanceTo(spell.mesh.position);
            if (dist < 40) { // Large pull radius
                const pullDir = spell.mesh.position.clone().sub(myPos).normalize();
                const pullStrength = Math.max(0, (40 - dist) / 40);
                
                // Pull toward center
                state.x += pullDir.x * pullStrength * 40 * dt;
                state.z += pullDir.z * pullStrength * 40 * dt;
                
                // If extremely close, FLING UP
                if (dist < 10) {
                    state.yVel += 150 * dt; 
                    // Add outward tangential push
                    const tangent = new THREE.Vector3(-pullDir.z, 0, pullDir.x);
                    state.x += tangent.x * 30 * dt;
                    state.z += tangent.z * 30 * dt;
                }
            }
        }
    });

    // Hit Detection: Authoritative Caster reports hits
    activeSpells.forEach(spell => {
        // Only the owner of the spell checks if it hit someone else
        if (spell.ownerId === socket.id && spell.mesh && !spell.hasHit) {
            Object.keys(players).forEach(targetId => {
                if (targetId === socket.id) return; // can't hit self
                const target = players[targetId];
                if (!target) return;

                let hit = false;
                if (spell.type === "box") {
                    // Box-based collision (Tsunami, Bramble Walls)
                    const spellBox = new THREE.Box3().setFromObject(spell.mesh);
                    // Add some padding to the spell box for reliability
                    if (spell.size) {
                         const center = spell.mesh.position;
                         spellBox.setFromCenterAndSize(center, spell.size);
                    }
                    const targetCenter = target.position.clone().add(new THREE.Vector3(0, 7, 0));
                    const targetBox = new THREE.Box3().setFromCenterAndSize(targetCenter, new THREE.Vector3(8, 14, 8));
                    if (spellBox.intersectsBox(targetBox)) hit = true;
                } else {
                    // Radius-based collision (Missiles, Spikes, Pulse)
                    const targetCenter2 = target.position.clone().add(new THREE.Vector3(0, 5, 0));
                    const dist = spell.mesh.position.distanceTo(targetCenter2);
                    const hitRadius = spell.radius || 5.5;
                    if (dist < hitRadius) hit = true;
                }

                if (hit) {
                    spell.hasHit = true;
                    const def = SpellRegistry[spell.spellName];
                    const dmg = def ? def.damage : 10;
                    socket.emit('playerHit', { targetId: targetId, damage: dmg });

                    // SPECIAL EFFECT: Entangle Root (sent as message or effect for now)
                    if (spell.spellName === "ENTANGLE") {
                         socket.emit('playerEffect', { targetId: targetId, effect: 'root', duration: 5 });
                    }
                }
            });
        }
    });

    // Update Match Timer HUD
    if (matchEndTime) {
        const timeRemainingMs = Math.max(0, matchEndTime - Date.now());
        const totalSeconds = Math.floor(timeRemainingMs / 1000);
        const mins = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
        const secs = (totalSeconds % 60).toString().padStart(2, '0');
        document.getElementById('match-timer').innerText = `${mins}:${secs}`;
    }

    if (myMesh && !state.isDead) {
        // Assume HP is stored in our players dict if we wanted to update the HP bar
        const localPlayerHitpoints = players[socket.id] ? players[socket.id].hp : 100;
        document.getElementById('hp-bar').style.width = localPlayerHitpoints + '%';
        document.getElementById('hp-text').innerText = localPlayerHitpoints + " / 100";

        // Mana Regeneration
        let manaRegenRate = 0; // Natural regen is 0 per user request
        if (state.shroomBuff) manaRegenRate = 3.0; // Shroom buff grants base 3
        
        // Check props proximity for bonus mana regen
        if (window.treeBoxes && window.bushBoxes) {
            let playerPos = new THREE.Vector3(state.x, state.y, state.z);
            let nearTree = false;
            let nearBush = false;
            
            for(const box of window.treeBoxes) {
                if(box.distanceToPoint(playerPos) < 30) { nearTree = true; break; }
            }
            if(!nearTree) {
                for(const box of window.bushBoxes) {
                    if(box.distanceToPoint(playerPos) < 15) { nearBush = true; break; }
                }
            }

            if(nearTree) manaRegenRate = 10.0; // Overrides base/shroom if near tree
            else if(nearBush) manaRegenRate = 5.0; // Overrides base/shroom if near bush
        }

        state.mana = Math.min(100, state.mana + manaRegenRate * dt);

        document.getElementById('mana-bar').style.width = state.mana + '%';
        document.getElementById('mana-text').innerText = Math.floor(state.mana) + " / 100";

        // Zoom Logic
        if (keys['KeyI']) state.zoom = Math.max(0, state.zoom - 2);
        if (keys['KeyO']) state.zoom = Math.min(400, state.zoom + 2);

        // Controls
        const baseSpeed = 0.5;
        const sprintMultiplier = keys['ShiftLeft'] ? 2.0 : 1.0;
        const shroomMultiplier = state.shroomBuff ? 3.0 : 1.0;
        const totalMultiplier = baseSpeed * sprintMultiplier * shroomMultiplier * (state.speedMultiplier || 1.0);
        
        let mx = 0, mz = 0;

        camera.fov = THREE.MathUtils.lerp(camera.fov, 60 + (totalMultiplier - 1) * 20, 0.1);
        camera.updateProjectionMatrix();

        // Relative to Camera Yaw
        if (keys['KeyW']) { mx -= Math.sin(state.yaw); mz -= Math.cos(state.yaw); }
        if (keys['KeyS']) { mx += Math.sin(state.yaw); mz += Math.cos(state.yaw); }
        if (keys['KeyA']) { mx -= Math.sin(state.yaw + Math.PI / 2); mz -= Math.cos(state.yaw + Math.PI / 2); }
        if (keys['KeyD']) { mx += Math.sin(state.yaw + Math.PI / 2); mz += Math.cos(state.yaw + Math.PI / 2); }

        if (mx !== 0 || mz !== 0) {
            const mag = Math.sqrt(mx * mx + mz * mz);
            state.x += (mx / mag) * totalMultiplier;
            state.z += (mz / mag) * totalMultiplier;
            // Face travel direction
            myMesh.rotation.y = Math.atan2(-mx, -mz);
        }

        // Apply Dash
        state.x += state.dashVel.x; state.z += state.dashVel.z;
        state.dashVel.x *= 0.85; state.dashVel.z *= 0.85;

        // Gravity & Collision
        state.yVel -= 0.08 + (state.yVel < 0 ? 0.04 : 0); // fall faster over time
        state.y += state.yVel;
        const ground = getTerrainHeight(state.x, state.z) + 1.5;
        if (state.y < ground) {
            state.y = ground;
            state.yVel = 0;
            state.isGrounded = true;
            state.jumpCount = 0;
        }

        myMesh.position.set(state.x, state.y, state.z);

        // Camera Update
        if (state.zoom < 2) {
            myMesh.visible = false;
            camera.position.set(state.x, state.y + 1, state.z);
            camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
        } else {
            myMesh.visible = true;
            const distH = state.zoom * Math.cos(state.pitch);
            const distV = state.zoom * Math.sin(-state.pitch) + 8;
            camera.position.set(
                state.x + Math.sin(state.yaw) * distH,
                state.y + distV,
                state.z + Math.cos(state.yaw) * distH
            );
            camera.lookAt(state.x, state.y + 3, state.z);
        }

        socket.emit('playerMovement', { x: state.x, y: state.y, z: state.z });
    }

    // Particle Logic & Shroom Collection
    const playerBox = new THREE.Box3();
    if (myMesh) playerBox.setFromObject(myMesh);

    // Collect shroom buff
    if (!state.shroomBuff) {
        for (let i = shroomBoxes.length - 1; i >= 0; i--) {
            if (playerBox.intersectsBox(shroomBoxes[i])) {
                state.shroomBuff = true;
                // visually remove
                scene.remove(shroomBoxes[i].uuid_obj);
                shroomBoxes.splice(i, 1);
            }
        }
    }

    // Wind Particle Logic
    for (let i = windParticles.length - 1; i >= 0; i--) {
        let p = windParticles[i];
        p.position.x += p.userData.speed;
        p.position.z += p.userData.speed;
        // Fade in based on height. High altitude = more wind visibility
        const targetOpacity = Math.max(0, Math.min(0.8, (p.position.y - 100) / 800));
        p.material.opacity = targetOpacity;
        if (p.position.x > 4000) p.position.x = -4000;
        if (p.position.z > 4000) p.position.z = -4000;
    }

    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.position.x += p.userData.vx;
        p.position.y += p.userData.vy;
        p.position.z += p.userData.vz;
        // Apply gravity for blood particles
        if (p.userData.gravity !== undefined) {
            p.userData.vy += p.userData.gravity;
        }
        p.userData.life -= dt * 3;
        p.material.opacity = Math.max(0, p.userData.life);
        p.scale.setScalar(Math.max(0.01, p.userData.life));
        if (p.userData.life <= 0) {
            scene.remove(p);
            particles.splice(i, 1);
        }
    }

    carpets.forEach(c => {
        c.angle += 0.01;
        // orbit giant tree at (500, 500)
        c.mesh.position.x = 500 + Math.cos(c.angle) * c.radius;
        c.mesh.position.z = 500 + Math.sin(c.angle) * c.radius * 0.5;
        c.mesh.position.y = getTerrainHeight(500,500) + 400 + Math.sin(dt*2)*20;
        c.mesh.rotation.y = -c.angle;
    });

    renderer.render(scene, camera);
}

async function startGame() {
    const loader = new GLTFLoader();
    const loadPromises = modelFiles.map(file => {
        return new Promise((resolve) => {
            loader.load(file, (gltf) => {
                gltf.scene.traverse(child => { if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
                resolve(gltf.scene);
            });
        });
    });

    const propFiles = ['assets/magi_tree.glb', 'assets/magi_bush.glb', 'assets/Shroooms.glb', 'assets/magi_carp.glb'];
    const propPromises = propFiles.map(file => {
        return new Promise((resolve) => {
            loader.load(file, gltf => {
                gltf.scene.traverse(child => { if(child.isMesh) { child.castShadow = true; child.receiveShadow = true; } });
                resolve(gltf.scene);
            });
        });
    });

    const [loadedScenes, loadedProps] = await Promise.all([
        Promise.all(loadPromises), 
        Promise.all(propPromises)
    ]);

    wizardModels.push(...loadedScenes);

    // Now that assets are loaded, we can safely connect and receive the state
    socket.on('initGame', (data) => {
        startSeededWorld(data.seed);
        initWorld(...loadedProps);
        initSocket();
        updateHotbarUI();
        animate();
    });

    socket.connect();
}

startGame();
