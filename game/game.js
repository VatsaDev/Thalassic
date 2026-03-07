import * as THREE from 'three';

// --- CONFIGURATION ---
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL);

// --- SCENE SETUP ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 15000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

// --- SKYBOX (GRADIENT) ---
const vertexShader = `
    varying vec3 vWorldPosition;
    void main() {
        vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
`;
const fragmentShader = `
    uniform vec3 topColor;
    uniform vec3 bottomColor;
    varying vec3 vWorldPosition;
    void main() {
        float h = normalize( vWorldPosition ).y;
        gl_FragColor = vec4( mix( bottomColor, topColor, max( h, 0.0 ) ), 1.0 );
    }
`;
const skyGeo = new THREE.SphereGeometry(12000, 32, 15);
const skyMat = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
        topColor: { value: new THREE.Color(0x0077ff) },
        bottomColor: { value: new THREE.Color(0xffffff) }
    },
    side: THREE.BackSide
});
scene.add(new THREE.Mesh(skyGeo, skyMat));

// --- LIGHTING ---
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(1000, 2000, 1000);
sun.castShadow = true;
sun.shadow.camera.left = -2000; sun.shadow.camera.right = 2000;
sun.shadow.camera.top = 2000; sun.shadow.camera.bottom = -2000;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

// --- TERRAIN GENERATION (10KM WORLD) ---
const WORLD_SIZE = 10000;
const CHUNK_SIZE = 2500;
const SEGMENTS = 128; // Per chunk

function getTerrainHeight(x, z) {
    const dist = Math.sqrt(x*x + z*z);
    const maxDist = WORLD_SIZE / 2;
    // Lighter exponential curve (squared instead of power of 4)
    let mask = Math.pow(dist / maxDist, 2.2); 

    let noise = 0;
    let amp = 1;
    let freq = 0.005;
    for(let i = 0; i < 5; i++) {
        noise += (Math.sin(x * freq) * Math.cos(z * freq)) * amp;
        freq *= 2.5;
        amp *= 0.4;
    }
    return mask * (noise + 1.5) * 800; // Peak around 1.5km
}

function createChunk(xOffset, zOffset) {
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + xOffset;
        const z = pos.getZ(i) + zOffset;
        const y = getTerrainHeight(x, z);
        pos.setY(i, y);

        const color = new THREE.Color();
        if (y > 900) color.set(0xffffff);
        else if (y > 400) color.set(0x777777);
        else if (y > 100) color.set(0x335533);
        else color.set(0x228B22);

        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    mesh.position.set(xOffset, 0, zOffset);
    mesh.receiveShadow = true;
    return mesh;
}

// Generate 4x4 grid of chunks
for(let x = -2; x < 2; x++) {
    for(let z = -2; z < 2; z++) {
        scene.add(createChunk(x * CHUNK_SIZE + CHUNK_SIZE/2, z * CHUNK_SIZE + CHUNK_SIZE/2));
    }
}

// --- PLAYER SYSTEM ---
const players = {}; 
let myMesh = null;

const state = {
    x: 0, y: 10, z: 0,
    yVel: 0, 
    yaw: 0, pitch: 0, // Mouse look
    jumpCount: 0, isGrounded: false,
    zoomLevel: 30, lastDash: 0,
    dashVel: { x: 0, z: 0 }
};

// --- MOUSE LOOK & KEYBOARD ---
const keys = {};
document.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    // WASD + Arrows
    if (e.code === 'Space') {
        if (state.isGrounded) { state.yVel = 1.5; state.jumpCount = 1; state.isGrounded = false; }
        else if (state.jumpCount < 2) { state.yVel = 1.2; state.jumpCount = 2; }
    }
    if (e.code === 'KeyQ') {
        const now = Date.now();
        if (now - state.lastDash > 500) {
            state.dashVel.x = Math.sin(state.yaw) * 10.0;
            state.dashVel.z = Math.cos(state.yaw) * 10.0;
            state.lastDash = now;
        }
    }
});
document.addEventListener('keyup', (e) => keys[e.code] = false);

// Pointer Lock for FPS
renderer.domElement.addEventListener('click', () => {
    renderer.domElement.requestPointerLock();
});

document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === renderer.domElement) {
        state.yaw -= e.movementX * 0.002;
        state.pitch -= e.movementY * 0.002;
        state.pitch = Math.max(-Math.PI/2, Math.min(Math.PI/2, state.pitch));
    }
});

// --- HELPERS ---
function createPlayerMesh(data) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: data.color }));
    body.castShadow = true;
    group.add(body);
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 64;
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.fillRect(0,0,256,64);
    ctx.font = "bold 30px Arial"; ctx.fillStyle = "white"; ctx.textAlign="center";
    ctx.fillText(data.name, 128, 42);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
    sprite.scale.set(6, 1.5, 1);
    sprite.position.y = 3;
    group.add(sprite);
    return group;
}

// --- NETWORKING ---
socket.on('currentPlayers', (serverPlayers) => {
    Object.keys(serverPlayers).forEach(id => {
        if (!players[id]) {
            players[id] = createPlayerMesh(serverPlayers[id]);
            scene.add(players[id]);
            if (id === socket.id) myMesh = players[id];
        }
    });
});
socket.on('newPlayer', (data) => {
    players[data.id] = createPlayerMesh(data.player);
    scene.add(players[data.id]);
});
socket.on('playerMoved', (data) => {
    if (data.id !== socket.id && players[data.id]) {
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
        if (keys['KeyO']) state.zoomLevel = Math.min(300, state.zoomLevel + 2);

        // Movement (Fixed for WASD + Arrows)
        const isSprinting = keys['ShiftLeft'] || keys['ShiftRight'];
        const speed = isSprinting ? 1.5 : 0.6;
        let mx = 0, mz = 0;

        if (keys['KeyW'] || keys['ArrowUp']) { mx += Math.sin(state.yaw); mz += Math.cos(state.yaw); }
        if (keys['KeyS'] || keys['ArrowDown']) { mx -= Math.sin(state.yaw); mz -= Math.cos(state.yaw); }
        if (keys['KeyA'] || keys['ArrowLeft']) { mx += Math.sin(state.yaw + Math.PI/2); mz += Math.cos(state.yaw + Math.PI/2); }
        if (keys['KeyD'] || keys['ArrowRight']) { mx -= Math.sin(state.yaw + Math.PI/2); mz -= Math.cos(state.yaw + Math.PI/2); }

        if (mx !== 0 || mz !== 0) {
            const mag = Math.sqrt(mx*mx + mz*mz);
            state.x += (mx/mag) * speed + state.dashVel.x;
            state.z += (mz/mag) * speed + state.dashVel.z;
        } else {
            state.x += state.dashVel.x;
            state.z += state.dashVel.z;
        }

        state.dashVel.x *= 0.85; state.dashVel.z *= 0.85;

        // Physics
        state.yVel -= 0.05;
        state.y += state.yVel;
        const floor = getTerrainHeight(state.x, state.z) + 1.0;
        if (state.y < floor) {
            state.y = floor; state.yVel = 0;
            state.isGrounded = true; state.jumpCount = 0;
        }

        myMesh.position.set(state.x, state.y, state.z);
        myMesh.rotation.y = state.yaw;

        // Camera Logic
        if (state.zoomLevel < 1) {
            myMesh.visible = false;
            camera.position.set(state.x, state.y + 0.8, state.z);
            camera.rotation.set(state.pitch, state.yaw + Math.PI, 0, 'YXZ');
        } else {
            myMesh.visible = true;
            camera.position.set(
                state.x - Math.sin(state.yaw) * state.zoomLevel,
                state.y + (state.zoomLevel * 0.4) + 5,
                state.z - Math.cos(state.yaw) * state.zoomLevel
            );
            camera.lookAt(state.x, state.y + 2, state.z);
        }

        socket.emit('playerMovement', { x: state.x, y: state.y, z: state.z });
    }

    renderer.render(scene, camera);
}
animate();
