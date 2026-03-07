import * as THREE from 'three';

// --- CONFIGURATION ---
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL);

// --- SCENE SETUP ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); // Sky Blue
// Add some fog for depth
scene.fog = new THREE.Fog(0x87CEEB, 10, 100);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// Lighting
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444);
hemiLight.position.set(0, 20, 0);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(50, 100, 50);
dirLight.castShadow = true;
scene.add(dirLight);

// --- TERRAIN GENERATION (NOISE) ---
// Simple pseudo-random noise function (replacing full Perlin for single-file simplicity)
function noise(x, z) {
    const sin = Math.sin;
    const cos = Math.cos;
    // Layering waves (Fractal Brownian Motion)
    return (sin(x / 20) * cos(z / 20) * 4) + 
           (sin(x / 10 + 1) * cos(z / 10 + 2) * 2) + 
           (sin(x / 5) * 0.5);
}

function getTerrainHeight(x, z) {
    // Return y height at specific coordinate
    return Math.max(-10, noise(x, z));
}

// Generate the Mesh
const worldSize = 400; // 10x larger
const resolution = 128; // Vertices per axis
const geometry = new THREE.PlaneGeometry(worldSize, worldSize, resolution, resolution);
geometry.rotateX(-Math.PI / 2); // Lay flat

const pos = geometry.attributes.position;
const colors = [];
const colorAttribute = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);

// Modify vertices based on noise
for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    
    // Calculate height
    const y = getTerrainHeight(x, z);
    pos.setY(i, y);

    // Color: Green for high, Sandy for low
    if (y < -1) {
        // Sand
        colors.push(0.76, 0.7, 0.5);
    } else {
        // Grass (vary slightly based on height)
        const g = 0.5 + (Math.random() * 0.1);
        colors.push(0.1, g, 0.1);
    }
}

geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
geometry.computeVertexNormals();

const material = new THREE.MeshStandardMaterial({ 
    vertexColors: true,
    roughness: 0.8 
});

const ground = new THREE.Mesh(geometry, material);
ground.receiveShadow = true;
scene.add(ground);

// --- PLAYER STATE ---
const players = {}; 
let myId = null;
let myMesh = null;

// Starting State
const state = {
    x: 0, 
    y: 10, // Spawn high to avoid sticking in a hill
    z: 0,
    yVelocity: 0,
    isGrounded: false,
    zoomLevel: 10,
    yaw: 0 // Camera rotation
};

// --- HELPER FUNCTIONS ---
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
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
    sprite.scale.set(4, 1, 1);
    sprite.position.y = 1.3;
    return sprite;
}

function createPlayerMesh(data) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: data.color })
    );
    mesh.position.set(data.x, data.y, data.z);
    mesh.castShadow = true;
    mesh.add(createNametag(data.name));
    return mesh;
}

// --- INPUTS ---
const keys = {};
window.addEventListener('keydown', (e) => keys[e.code] = true);
window.addEventListener('keyup', (e) => keys[e.code] = false);

// --- SOCKET EVENTS ---
socket.on('connect', () => { myId = socket.id; });

socket.on('currentPlayers', (serverPlayers) => {
    Object.keys(serverPlayers).forEach((id) => {
        if (!players[id]) {
            const p = serverPlayers[id];
            const mesh = createPlayerMesh(p);
            scene.add(mesh);
            players[id] = mesh;
            if (id === myId) {
                myMesh = mesh;
                state.x = p.x; state.y = p.y; state.z = p.z;
            }
        }
    });
});

socket.on('newPlayer', (data) => {
    const mesh = createPlayerMesh(data.player);
    scene.add(mesh);
    players[data.id] = mesh;
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
const GRAVITY = 0.02;
const JUMP_FORCE = 0.5;
const SPEED = 0.2;

function animate() {
    requestAnimationFrame(animate);

    if (myMesh) {
        // --- INPUT LOGIC ---
        // Zoom I/O
        if (keys['KeyI']) state.zoomLevel = Math.max(0, state.zoomLevel - 0.5);
        if (keys['KeyO']) state.zoomLevel = Math.min(30, state.zoomLevel + 0.5);

        // Movement Calculation
        // Use camera angle for movement direction
        const camDir = new THREE.Vector3();
        camera.getWorldDirection(camDir);
        camDir.y = 0; // Flatten to XZ plane
        camDir.normalize();

        const camSide = new THREE.Vector3();
        camSide.crossVectors(camera.up, camDir).normalize(); // Get Right vector (actually Left in ThreeJS usually)

        let dx = 0; 
        let dz = 0;
        let moving = false;

        // WASD relative to camera
        if (keys['KeyW']) { dx += camDir.x; dz += camDir.z; moving = true; }
        if (keys['KeyS']) { dx -= camDir.x; dz -= camDir.z; moving = true; }
        if (keys['KeyA']) { dx += camSide.x; dz += camSide.z; moving = true; }
        if (keys['KeyD']) { dx -= camSide.x; dz -= camSide.z; moving = true; }

        if (moving) {
            // Normalize speed so diagonal isn't faster
            const len = Math.sqrt(dx*dx + dz*dz);
            if (len > 0) {
                dx = (dx / len) * SPEED;
                dz = (dz / len) * SPEED;
            }
            state.x += dx;
            state.z += dz;
            
            // Rotate player to face movement
            myMesh.rotation.y = Math.atan2(dx, dz);
        }

        // --- PHYSICS & COLLISION ---
        // 1. Get height of ground at current X, Z
        const groundHeight = getTerrainHeight(state.x, state.z);
        const playerHeight = 0.5; // Half of cube height

        // 2. Jump
        if (keys['Space'] && state.isGrounded) {
            state.yVelocity = JUMP_FORCE;
            state.isGrounded = false;
        }

        // 3. Apply Gravity
        state.yVelocity -= GRAVITY;
        state.y += state.yVelocity;

        // 4. Floor Collision
        if (state.y < groundHeight + playerHeight) {
            state.y = groundHeight + playerHeight;
            state.yVelocity = 0;
            state.isGrounded = true;
        }

        // --- UPDATE MESH ---
        myMesh.position.set(state.x, state.y, state.z);

        // --- CAMERA UPDATE ---
        if (state.zoomLevel < 0.5) {
            // First Person
            myMesh.visible = false;
            camera.position.set(state.x, state.y + 0.5, state.z);
            // Simple look logic (just look forward based on last move or fixed)
            // Ideally FPS needs mouse look, but keeping it simple:
            const lookTargetX = state.x + dx * 10;
            const lookTargetZ = state.z + dz * 10;
            if (moving) camera.lookAt(lookTargetX, state.y, lookTargetZ);
        } else {
            // Third Person (Fixed offset angle style)
            myMesh.visible = true;
            const camOffsetH = state.zoomLevel; 
            const camOffsetV = state.zoomLevel * 0.5 + 2;
            
            camera.position.set(state.x, state.y + camOffsetV, state.z + camOffsetH);
            camera.lookAt(state.x, state.y, state.z);
        }

        // Send to server
        socket.emit('playerMovement', { x: state.x, y: state.y, z: state.z });
    }

    renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

animate();
