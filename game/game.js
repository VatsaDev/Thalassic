import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createNoise2D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * ============================================================================
 * 1. INITIALIZATION & GLOBAL SETTINGS
 * ============================================================================
 */
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL, { 
    autoConnect: false 
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 20000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const noise2D = createNoise2D();
const clock = new THREE.Clock();

function seededRandom(s) {
    const x = Math.sin(s) * 10000;
    return x - Math.floor(x);
}

const wizardModels = [];
const modelFiles = [
    'assets/wizord_orang.glb',
    'assets/wizord_green.glb',
    'assets/wizord_sky.glb',
    'assets/wizord_blu.glb',
    'assets/wizord_purp.glb',
    'assets/wizord_red.glb'
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
    for (let i = 0; i < 15; i++) {
        const w = 0.2, h = 10.0; // 4x taller
        const geo = new THREE.BufferGeometry();
        const verts = new Float32Array([-w,0,0, w,0,0, 0,h,0,  0,0,-w, 0,0,w, 0,h,0]);
        geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
        
        // Randomly scatter blades in a small bunch
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.sqrt(Math.random()) * 1.5;
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
                    const scale = 1.0 + seededRandom(seed + 1) * 10.0;
                    dummy.scale.set(scale, scale, scale);
                    dummy.rotation.y = seededRandom(seed + 2) * Math.PI;
                    dummy.updateMatrix();
                    treeMatrices.push(dummy.matrix.clone());
                } else if (rand > 0.8) { 
                    dummy.position.set(localX, y, localZ);
                    dummy.scale.setScalar(0.8 + seededRandom(seed + 3) * 0.5);
                    dummy.rotation.y = seededRandom(seed + 4) * Math.PI;
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
// Generate the grid
for (let x = -4; x < 4; x++) {
    for (let z = -4; z < 4; z++) {
        scene.add(createChunk(x * CHUNK_SIZE + CHUNK_SIZE/2, z * CHUNK_SIZE + CHUNK_SIZE/2));
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

/**
 * ============================================================================
 * 7. CHARACTER CONTROLLER & PHYSICS
 * ============================================================================
 */
const players = {};
let myMesh = null;

const state = {
    x: 50, y: 100, z: -50, // Spawn high
    yVel: 0,
    yaw: 0, pitch: 0,
    zoom: 40,
    isGrounded: false, jumpCount: 0,
    dashVel: { x: 0, z: 0 },
    lastDash: 0
};

function createPlayerMesh(data) {
    const group = new THREE.Group();
    
    if (wizardModels.length > 0) {
        // Simple hash: Sum of character codes in ID string
        const idHash = data.id.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
        const modelIndex = idHash % wizardModels.length;
        
        const wizard = wizardModels[modelIndex].clone();
        
        // Adjust scale/rotation if your models come in sideways or tiny
        wizard.scale.set(2, 2, 2); 
        wizard.rotation.y = -2*Math.PI; // Face forward (neg fixes direction)
         
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

// Controls
const keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space') {
        if (state.isGrounded) {
            state.yVel = 1.6; // High Jump
            state.jumpCount = 1;
            state.isGrounded = false;
        } else if (state.jumpCount < 2) {
            state.yVel = 1.6; // SAME HEIGHT DOUBLE JUMP
            state.jumpCount = 2;
        }
    }
    if (e.code === 'KeyQ' && Date.now() - state.lastDash > 500) {
        state.dashVel.x = -Math.sin(state.yaw) * 15;
        state.dashVel.z = -Math.cos(state.yaw) * 15;
        state.lastDash = Date.now();
    }
});
window.addEventListener('keyup', (e) => keys[e.code] = false);

// Camera Look
document.addEventListener('click', () => document.body.requestPointerLock());
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
    });

    socket.on('playerMoved', (d) => { 
        if (players[d.id] && d.id !== socket.id) {
            players[d.id].position.set(d.x, d.y, d.z); 
        }
    });

    socket.on('playerDisconnected', (id) => { 
        if (players[id]) { 
            scene.remove(players[id]); 
            delete players[id]; 
        } 
    });
}

/**
 * ============================================================================
 * 9. MAIN GAME LOOP
 * ============================================================================
 */
function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getElapsedTime();
    
    if (foliageShader) {
      foliageShader.uniforms.time.value = dt;
    }

    if (myMesh) {
        // Zoom Logic
        if (keys['KeyI']) state.zoom = Math.max(0, state.zoom - 2);
        if (keys['KeyO']) state.zoom = Math.min(400, state.zoom + 2);

        // Character Movement (Smooth Tank Controls)
        const sprint = keys['ShiftLeft'] ? 2.5 : 1.0;
        let mx = 0, mz = 0;
        
        // Relative to Camera Yaw
        if (keys['KeyW']) { mx -= Math.sin(state.yaw); mz -= Math.cos(state.yaw); }
        if (keys['KeyS']) { mx += Math.sin(state.yaw); mz += Math.cos(state.yaw); }
        if (keys['KeyA']) { mx -= Math.sin(state.yaw + Math.PI/2); mz -= Math.cos(state.yaw + Math.PI/2); }
        if (keys['KeyD']) { mx += Math.sin(state.yaw + Math.PI/2); mz += Math.cos(state.yaw + Math.PI/2); }

        if (mx !== 0 || mz !== 0) {
            const mag = Math.sqrt(mx * mx + mz * mz);
            state.x += (mx / mag) * sprint;
            state.z += (mz / mag) * sprint;
            // Face travel direction
            myMesh.rotation.y = Math.atan2(-mx, -mz);
        }

        // Apply Dash
        state.x += state.dashVel.x; state.z += state.dashVel.z;
        state.dashVel.x *= 0.85; state.dashVel.z *= 0.85;

        // Gravity & Collision
        state.yVel -= 0.05;
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

    renderer.render(scene, camera);
}

async function loadAssets() {
    const loader = new GLTFLoader();
    const loadPromises = modelFiles.map(file => {
        return new Promise((resolve) => {
            loader.load(file, (gltf) => {
                // Pre-configure shadows for the model
                gltf.scene.traverse(child => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                    }
                });
                resolve(gltf.scene);
            });
        });
    });

    const loadedScenes = await Promise.all(loadPromises);
    wizardModels.push(...loadedScenes);
    
    initSocket();
    socket.connect(); 
    animate(); 
}

loadAssets();
