import * as THREE from 'three';

// --- CONFIGURATION ---
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL);

// --- SCENE SETUP ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); // Clear Blue Sky

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// --- LIGHTING (ROBLOX STYLE) ---
const ambient = new THREE.AmbientLight(0xffffff, 0.5);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(200, 1000, 500);
sun.castShadow = true;

// High-res shadows for a large map
sun.shadow.camera.left = -1000;
sun.shadow.camera.right = 1000;
sun.shadow.camera.top = 1000;
sun.shadow.camera.bottom = -1000;
sun.shadow.camera.far = 3000;
sun.shadow.mapSize.set(4096, 4096);
scene.add(sun);

// --- TERRAIN ENGINE (1KM HIGH RES) ---
const WORLD_SIZE = 1000;
const RESOLUTION = 1000; // 1,000,000 vertices total

function getTerrainHeight(x, z) {
    // 1. Distance from center (0,0)
    const dist = Math.sqrt(x*x + z*z);
    const maxDist = WORLD_SIZE / 2;
    
    // 2. Exponential Mask (0 at center, peaks at edge)
    let mask = Math.pow(dist / maxDist, 4); 

    // 3. FBM Noise for Jagged Peaks
    let noise = 0;
    let amp = 1;
    let freq = 0.01;
    for(let i = 0; i < 6; i++) {
        // Ridge noise effect for steeper mountains
        noise += (1.0 - Math.abs(Math.sin(x * freq) * Math.cos(z * freq))) * amp;
        freq *= 2.2;
        amp *= 0.5;
    }

    // 4. Combine: Height 0 at center, up to 1000 at edges
    return mask * noise * 800; 
}

const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, RESOLUTION - 1, RESOLUTION - 1);
geometry.rotateX(-Math.PI / 2);

const pos = geometry.attributes.position;
const colors = new Float32Array(pos.count * 3);

for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = getTerrainHeight(x, z);
    pos.setY(i, y);

    // Color based on height and slope
    const color = new THREE.Color();
    if (y > 600) color.set(0xffffff); // Snow
    else if (y > 250) color.set(0x7c7c7c); // Dark Rock
    else if (y > 50) color.set(0x4d5d4d); // High Grass
    else color.set(0x228B22); // Valley Green

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
}

geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
geometry.computeVertexNormals();

const terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ 
    vertexColors: true, 
    roughness: 0.8 
}));
terrain.receiveShadow = true;
scene.add(terrain);

// --- PLAYER SYSTEM ---
const players = {}; 
let myId = null;
let myMesh = null;

const state = {
    x: 0, y: 10, z: 0,
    yVel: 0, yaw: 0,
    jumpCount: 0, isGrounded: false,
    zoomLevel: 25, lastDash: 0,
    dashVel: { x: 0, z: 0 }
};

function createPlayerMesh(data) {
    const group = new THREE.Group();
    // Character Cube
    const body = new THREE.Mesh(
        new THREE.BoxGeometry(2, 2, 2), 
        new THREE.MeshStandardMaterial({ color: data.color })
    );
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);
    
    // Nametag
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 512; canvas.height = 128;
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.roundRect(0,0,512,128,20); ctx.fill();
    ctx.font = "bold 60px Arial"; ctx.fillStyle = "white"; ctx.textAlign="center";
    ctx.fillText(data.name, 256, 85);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
    sprite.scale.set(8, 2, 1);
    sprite.position.y = 3.5;
    group.add(sprite);
    
    return group;
}

// --- CONTROLS ---
const keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    // CRANKED UP JUMP
    if (e.code === 'Space') {
        if (state.isGrounded) {
            state.yVel = 1.2; // Massive primary jump
            state.jumpCount = 1;
            state.isGrounded = false;
        } else if (state.jumpCount < 2) {
            state.yVel = 1.0; // Strong double jump
            state.jumpCount = 2;
        }
    }
    // CRANKED UP DASH
    if (e.code === 'KeyQ') {
        const now = Date.now();
        if (now - state.lastDash > 500) {
            state.dashVel.x = Math.sin(state.yaw) * 6.0; // Extreme dash force
            state.dashVel.z = Math.cos(state.yaw) * 6.0;
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
        // Zoom I/O
        if (keys['KeyI']) state.zoomLevel = Math.max(0, state.zoomLevel - 2);
        if (keys['KeyO']) state.zoomLevel = Math.min(200, state.zoomLevel + 2);

        // Turn
        if (keys['KeyA']) state.yaw += 0.05;
        if (keys['KeyD']) state.yaw -= 0.05;
        myMesh.rotation.y = state.yaw;

        // Move
        const sprint = keys['ShiftLeft'] ? 1.2 : 0.5;
        let mx = 0, mz = 0;
        if (keys['KeyW']) { mx = Math.sin(state.yaw) * sprint; mz = Math.cos(state.yaw) * sprint; }
        if (keys['KeyS']) { mx = -Math.sin(state.yaw) * sprint; mz = -Math.cos(state.yaw) * sprint; }

        state.x += mx + state.dashVel.x;
        state.z += mz + state.dashVel.z;
        state.dashVel.x *= 0.82; state.dashVel.z *= 0.82; // Dash friction

        // Physics
        state.yVel -= 0.045; // Gravity
        state.y += state.yVel;

        const floor = getTerrainHeight(state.x, state.z) + 1.0;
        if (state.y < floor) {
            state.y = floor; state.yVel = 0;
            state.isGrounded = true; state.jumpCount = 0;
        }

        myMesh.position.set(state.x, state.y, state.z);

        // Camera Follow
        if (state.zoomLevel < 1) {
            myMesh.visible = false;
            camera.position.set(state.x, state.y + 0.5, state.z);
            camera.rotation.set(0, state.yaw + Math.PI, 0);
        } else {
            myMesh.visible = true;
            camera.position.set(
                state.x - Math.sin(state.yaw) * state.zoomLevel,
                state.y + (state.zoomLevel * 0.5) + 5,
                state.z - Math.cos(state.yaw) * state.zoomLevel
            );
            camera.lookAt(state.x, state.y + 2, state.z);
        }

        socket.emit('playerMovement', { x: state.x, y: state.y, z: state.z });
    }

    renderer.render(scene, camera);
}
animate();
