import * as THREE from 'three';

// --- CONFIGURATION ---
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL);

// --- SCENE SETUP ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x92a1b1); // Gloomy mountain sky
scene.fog = new THREE.Fog(0x92a1b1, 50, 400); // Farther fog

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.position.set(100, 200, 100);
sun.castShadow = true;
scene.add(sun);

// --- TERRAIN GENERATION (ADVANCED NOISE) ---
const WORLD_SIZE = 1000;
const RESOLUTION = 200; // Vertices per side

// Better noise: Fractal Brownian Motion
function fbm(x, z) {
    let value = 0;
    let amplitude = 15; // Base height scale
    let frequency = 0.01;
    for (let i = 0; i < 4; i++) {
        value += (Math.sin(x * frequency) * Math.cos(z * frequency)) * amplitude;
        frequency *= 2.5;
        amplitude *= 0.4;
    }
    // Boost height for mountains
    if (value > 5) value += Math.pow(value - 5, 1.5); 
    return value;
}

function getTerrainHeight(x, z) {
    return fbm(x, z);
}

const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, RESOLUTION, RESOLUTION);
geometry.rotateX(-Math.PI / 2);

const positions = geometry.attributes.position;
const colors = new Float32Array(positions.count * 3);

for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const y = getTerrainHeight(x, z);
    positions.setY(i, y);

    // Color Logic
    let color = new THREE.Color();
    
    // 1. Calculate approximate slope (cheap way)
    const neighborY = getTerrainHeight(x + 2, z);
    const slope = Math.abs(y - neighborY);

    if (y > 28) { // Snowy Peaks
        color.set(0xffffff);
    } else if (slope > 1.2) { // Steep Cliffs -> Gray Rock
        color.set(0x777777);
    } else if (y > 10) { // High Tundra -> Darker Green/Gray
        color.set(0x445544);
    } else if (y < -2) { // Valleys -> Sandy
        color.set(0xc2b280);
    } else { // Normal ground
        color.set(0x228B22);
    }

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
}

geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
geometry.computeVertexNormals();
const terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
terrain.receiveShadow = true;
scene.add(terrain);

// --- PLAYER STATE ---
const players = {}; 
let myId = null;
let myMesh = null;

const state = {
    x: 0, y: 50, z: 0,
    yVel: 0,
    yaw: 0,           // Rotation angle
    jumpCount: 0,     // For Double Jump
    isGrounded: false,
    zoomLevel: 10,
    lastDash: 0,      // Timestamp
    dashVel: { x: 0, z: 0 }
};

// --- HELPERS ---
function createNametag(text) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 64;
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = "bold 28px Arial";
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.fillText(text, 128, 42);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
    sprite.scale.set(4, 1, 1);
    sprite.position.y = 1.3;
    return sprite;
}

function createPlayerMesh(data) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: data.color }));
    mesh.castShadow = true;
    mesh.add(createNametag(data.name));
    return mesh;
}

// --- INPUTS ---
const keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    // Single-press events (Jump & Dash)
    if (e.code === 'Space') handleJump();
    if (e.code === 'KeyQ') handleDash();
});
window.addEventListener('keyup', (e) => keys[e.code] = false);

function handleJump() {
    if (state.isGrounded) {
        state.yVel = 0.5;
        state.jumpCount = 1;
        state.isGrounded = false;
    } else if (state.jumpCount < 2) {
        state.yVel = 0.4; // Double jump slightly weaker
        state.jumpCount = 2;
    }
}

function handleDash() {
    const now = Date.now();
    if (now - state.lastDash > 500) { // 0.5s cooldown
        const power = 1.5;
        state.dashVel.x = Math.sin(state.yaw) * power;
        state.dashVel.z = Math.cos(state.yaw) * power;
        state.lastDash = now;
    }
}

// --- NETWORK ---
socket.on('currentPlayers', (serverPlayers) => {
    Object.keys(serverPlayers).forEach(id => {
        if (!players[id]) {
            players[id] = createPlayerMesh(serverPlayers[id]);
            scene.add(players[id]);
            if (id === socket.id) {
                myId = id; myMesh = players[id];
            }
        }
    });
});
socket.on('newPlayer', (data) => {
    players[data.id] = createPlayerMesh(data.player);
    scene.add(players[data.id]);
});
socket.on('playerMoved', (data) => {
    if (data.id !== myId && players[data.id]) {
        players[data.id].position.set(data.x, data.y, data.z);
    }
});
socket.on('playerDisconnected', (id) => {
    if (players[id]) { scene.remove(players[id]); delete players[id]; }
});

// --- GAME LOOP ---
function animate() {
    requestAnimationFrame(animate);

    if (myMesh) {
        // 1. Zoom Logic
        if (keys['KeyI']) state.zoomLevel = Math.max(0, state.zoomLevel - 0.5);
        if (keys['KeyO']) state.zoomLevel = Math.min(50, state.zoomLevel + 0.5);

        // 2. Rotation (A / D) - Turning 15 degrees is quite fast, using 0.05 radians (~3 deg) per frame for smoothness
        if (keys['KeyA']) state.yaw += 0.05;
        if (keys['KeyD']) state.yaw -= 0.05;
        myMesh.rotation.y = state.yaw;

        // 3. Movement (W / S) - Moves in the direction of Yaw
        let moveX = 0;
        let moveZ = 0;
        const speed = 0.25;

        if (keys['KeyW']) {
            moveX = Math.sin(state.yaw) * speed;
            moveZ = Math.cos(state.yaw) * speed;
        }
        if (keys['KeyS']) {
            moveX = -Math.sin(state.yaw) * speed;
            moveZ = -Math.cos(state.yaw) * speed;
        }

        // Apply movement + dash friction
        state.x += moveX + state.dashVel.x;
        state.z += moveZ + state.dashVel.z;
        state.dashVel.x *= 0.9; // Dash decays quickly
        state.dashVel.z *= 0.9;

        // 4. Physics (Gravity + Ground)
        state.yVel -= 0.02; // Gravity
        state.y += state.yVel;

        const h = getTerrainHeight(state.x, state.z) + 0.5;
        if (state.y < h) {
            state.y = h;
            state.yVel = 0;
            state.isGrounded = true;
            state.jumpCount = 0;
        }

        myMesh.position.set(state.x, state.y, state.z);

        // 5. Camera Follow Logic
        if (state.zoomLevel < 1) {
            // First Person: Camera inside head, looking forward
            myMesh.visible = false;
            camera.position.set(state.x, state.y + 0.4, state.z);
            camera.rotation.y = state.yaw + Math.PI; // Correct for front view
        } else {
            // Third Person: Camera orbits behind player based on Yaw
            myMesh.visible = true;
            const camDist = state.zoomLevel;
            const camHeight = 3 + (state.zoomLevel * 0.3);
            
            // Calculate camera position relative to player rotation
            camera.position.set(
                state.x - Math.sin(state.yaw) * camDist,
                state.y + camHeight,
                state.z - Math.cos(state.yaw) * camDist
            );
            camera.lookAt(state.x, state.y + 1, state.z);
        }

        socket.emit('playerMovement', { x: state.x, y: state.y, z: state.z });
    }

    renderer.render(scene, camera);
}

animate();
