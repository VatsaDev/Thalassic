import * as THREE from 'three';

// --- CONFIGURATION ---
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL);

// --- SCENE SETUP ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xaaccff); // Brighter sky
scene.fog = new THREE.FogExp2(0xaaccff, 0.002); // Exponential fog for "atmosphere"

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 3000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(500, 1000, 500);
sun.castShadow = true;
sun.shadow.camera.left = -500;
sun.shadow.camera.right = 500;
sun.shadow.camera.top = 500;
sun.shadow.camera.bottom = -500;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

// --- ADVANCED NOISE & TERRAIN ---
const WORLD_SIZE = 1200;
const RESOLUTION = 350; // High resolution for smooth mountains

function fbm(x, z) {
    let v = 0;
    let amp = 80; // MASSIVE base height
    let freq = 0.003;
    // 7 Layers of noise for "Detail"
    for(let i = 0; i < 7; i++){
        v += Math.sin(x * freq) * Math.cos(z * freq) * amp;
        // Make it jagged: take absolute value for some octaves
        if(i > 2) v += Math.abs(Math.sin(x * freq * 2)) * (amp * 0.2);
        freq *= 2.1;
        amp *= 0.45;
    }
    return v;
}

function getTerrainHeight(x, z) {
    return fbm(x, z);
}

const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, RESOLUTION, RESOLUTION);
geometry.rotateX(-Math.PI / 2);

const pos = geometry.attributes.position;
const colors = new Float32Array(pos.count * 3);

for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = getTerrainHeight(x, z);
    pos.setY(i, y);

    // Dynamic Coloring based on Height + Slope
    const color = new THREE.Color();
    const nx = getTerrainHeight(x + 1, z);
    const nz = getTerrainHeight(x, z + 1);
    const slope = Math.sqrt(Math.pow(y - nx, 2) + Math.pow(y - nz, 2));

    if (y > 90) { // Snow peaks
        color.set(0xffffff);
    } else if (slope > 1.8) { // Steep Rock
        color.set(0x666666);
    } else if (y > 40) { // High Tundra (Grey-Green)
        color.set(0x4a5d4a);
    } else if (y < -15) { // Deep Valleys (Dark dirt/Wet)
        color.set(0x3d3321);
    } else { // Grassland
        color.set(0x2d5a27);
    }

    // "Ambient Occlusion" shadow for valleys
    const shadow = Math.min(1.0, (y + 50) / 100);
    color.multiplyScalar(0.7 + shadow * 0.3);

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
}

geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
geometry.computeVertexNormals();

const terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ 
    vertexColors: true, 
    flatShading: false, // Set to true for a "low poly" look, false for smooth
    roughness: 0.8
}));
terrain.receiveShadow = true;
scene.add(terrain);

// --- PLAYER SYSTEM ---
const players = {}; 
let myId = null;
let myMesh = null;

const state = {
    x: 0, y: 150, z: 0, // Spawn high!
    yVel: 0, yaw: 0,
    jumpCount: 0, isGrounded: false,
    zoomLevel: 15, lastDash: 0,
    dashVel: { x: 0, z: 0 }
};

function createPlayerMesh(data) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshStandardMaterial({ color: data.color }));
    body.castShadow = true;
    group.add(body);
    
    // Nametag
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 64;
    ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(0,0,256,64);
    ctx.font = "bold 32px Arial"; ctx.fillStyle = "white"; ctx.textAlign="center";
    ctx.fillText(data.name, 128, 45);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
    sprite.scale.set(5, 1.25, 1);
    sprite.position.y = 2;
    group.add(sprite);
    
    return group;
}

// --- CONTROLS ---
const keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space') {
        if (state.isGrounded) { state.yVel = 0.8; state.jumpCount = 1; state.isGrounded = false; }
        else if (state.jumpCount < 2) { state.yVel = 0.6; state.jumpCount = 2; }
    }
    if (e.code === 'KeyQ') {
        const now = Date.now();
        if (now - state.lastDash > 500) {
            state.dashVel.x = Math.sin(state.yaw) * 2.5;
            state.dashVel.z = Math.cos(state.yaw) * 2.5;
            state.lastDash = now;
        }
    }
});
window.addEventListener('keyup', (e) => keys[e.code] = false);

// --- NETWORKING ---
socket.on('currentPlayers', (serverPlayers) => {
    Object.keys(serverPlayers).forEach(id => {
        if (!players[id]) {
            players[id] = createPlayerMesh(serverPlayers[id]);
            scene.add(players[id]);
            if (id === socket.id) { myId = id; myMesh = players[id]; }
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

// --- MAIN LOOP ---
function animate() {
    requestAnimationFrame(animate);

    if (myMesh) {
        // Zoom
        if (keys['KeyI']) state.zoomLevel = Math.max(0, state.zoomLevel - 1);
        if (keys['KeyO']) state.zoomLevel = Math.min(100, state.zoomLevel + 1);

        // Turn & Move
        if (keys['KeyA']) state.yaw += 0.04;
        if (keys['KeyD']) state.yaw -= 0.04;
        myMesh.rotation.y = state.yaw;

        const speed = keys['ShiftLeft'] ? 0.8 : 0.4; // Added Sprint
        let mx = 0, mz = 0;
        if (keys['KeyW']) { mx = Math.sin(state.yaw) * speed; mz = Math.cos(state.yaw) * speed; }
        if (keys['KeyS']) { mx = -Math.sin(state.yaw) * speed; mz = -Math.cos(state.yaw) * speed; }

        state.x += mx + state.dashVel.x;
        state.z += mz + state.dashVel.z;
        state.dashVel.x *= 0.85; state.dashVel.z *= 0.85;

        // Physics
        state.yVel -= 0.035; // Heavier gravity for big mountains
        state.y += state.yVel;

        const floor = getTerrainHeight(state.x, state.z) + 0.75;
        if (state.y < floor) {
            state.y = floor; state.yVel = 0;
            state.isGrounded = true; state.jumpCount = 0;
        }

        myMesh.position.set(state.x, state.y, state.z);

        // Camera Follow
        if (state.zoomLevel < 1) {
            myMesh.visible = false;
            camera.position.set(state.x, state.y + 0.5, state.z);
            camera.rotation.y = state.yaw + Math.PI;
        } else {
            myMesh.visible = true;
            camera.position.set(
                state.x - Math.sin(state.yaw) * state.zoomLevel,
                state.y + (state.zoomLevel * 0.4) + 3,
                state.z - Math.cos(state.yaw) * state.zoomLevel
            );
            camera.lookAt(state.x, state.y + 2, state.z);
        }

        socket.emit('playerMovement', { x: state.x, y: state.y, z: state.z });
    }

    renderer.render(scene, camera);
}
animate();
