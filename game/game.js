import * as THREE from 'three';

// --- CONFIGURATION ---
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL);

// --- SCENE SETUP ---
const scene = new THREE.Scene();

// 1. SKY & FOG (Crisp, not blurry)
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
const skyMat = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
        topColor: { value: new THREE.Color(0x0077ff) },
        bottomColor: { value: new THREE.Color(0xffffff) }
    },
    side: THREE.BackSide
});
const skyGeo = new THREE.SphereGeometry(20000, 32, 15);
scene.add(new THREE.Mesh(skyGeo, skyMat));

// Fog that blends the distant chunks
scene.fog = new THREE.Fog(0xffffff, 1000, 8000);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 20000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // Softer shadows
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

// --- LIGHTING ---
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
scene.add(hemiLight);

const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(2000, 3000, 2000);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 10000;
const d = 4000;
sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
sun.shadow.bias = -0.0001;
scene.add(sun);

// --- TERRAIN ENGINE (EROSION & DERIVATIVE NOISE) ---
const WORLD_SIZE = 10000; // 10km
const CHUNKS_SIDE = 8;    // 64 Chunks total
const CHUNK_SIZE = WORLD_SIZE / CHUNKS_SIDE; 
const SEGMENTS = 128;     // High vertex density

// Pseudo-random hash
function hash(x, z) {
    let k = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
    return k - Math.floor(k);
}

// Cubic interpolation
function mix(a, b, t) { return a * (1-t) + b * t; }
function smooth(t) { return t * t * (3 - 2 * t); }

// Value Noise for base shape
function vNoise(x, z) {
    let ix = Math.floor(x); let iz = Math.floor(z);
    let fx = x - ix; let fz = z - iz;
    let u = smooth(fx); let v = smooth(fz);
    let a = hash(ix, iz); let b = hash(ix+1, iz);
    let c = hash(ix, iz+1); let d = hash(ix+1, iz+1);
    return mix(mix(a, b, u), mix(c, d, u), v);
}

// "Erosion" Noise - Uses derivative to simulate flow
function getTerrainHeight(x, z) {
    const dist = Math.sqrt(x*x + z*z);
    
    // 1. Exponential Mask (Valley in middle, Mountains at edge)
    // Using power 2.5 for a wide playable valley
    const mask = Math.pow(Math.min(1.0, dist / (WORLD_SIZE/2.1)), 2.5);

    // 2. Multi-Fractal Noise with "Erosion" Look
    let y = 0;
    let amp = 1;
    let freq = 0.002;
    
    for (let i = 0; i < 6; i++) {
        // Absolute value creates sharp ridges (ridges = 1 - abs(noise))
        let n = 1.0 - Math.abs(Math.sin(x * freq + vNoise(x*freq, z*freq)) + Math.cos(z * freq));
        
        // Sharpen peaks (power function)
        n = Math.pow(n, 2.0); 
        
        y += n * amp;
        amp *= 0.45; // Lacunarity
        freq *= 2.0;
    }

    // 3. Scale Height
    // Max height 1800m at edges
    return mask * (y * 1800); 
}

// --- GRASS SYSTEM ---
// Instanced Mesh for performance
const grassGeo = new THREE.PlaneGeometry(2, 4); // Larger grass blades
const grassMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    side: THREE.DoubleSide,
    vertexShader: `
        varying vec2 vUv;
        uniform float time;
        void main() {
            vUv = uv;
            vec4 pos = vec4(position, 1.0);
            // Wind Calculation based on world position
            float wind = sin(time * 2.0 + instanceMatrix[3][0] * 0.1 + instanceMatrix[3][2] * 0.1);
            if (pos.y > 0.0) { // Only move top of blade
                pos.x += wind * 0.5;
            }
            gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * pos;
        }
    `,
    fragmentShader: `
        varying vec2 vUv;
        void main() {
            vec3 color = mix(vec3(0.1, 0.5, 0.1), vec3(0.4, 0.8, 0.2), vUv.y);
            if (color.g < 0.2) discard; // Simple alpha test
            gl_FragColor = vec4(color, 1.0);
        }
    `
});

// --- CHUNK MANAGER ---
function createChunk(xOffset, zOffset) {
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    
    // Grass Placement Arrays
    const grassMatrices = [];
    const grassDummy = new THREE.Object3D();

    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + xOffset;
        const z = pos.getZ(i) + zOffset;
        const y = getTerrainHeight(x, z);
        pos.setY(i, y);

        // Slope Calculation
        // Sample neighbors for normal calculation proxy
        const hR = getTerrainHeight(x+10, z);
        const hL = getTerrainHeight(x-10, z);
        const hD = getTerrainHeight(x, z+10);
        const hU = getTerrainHeight(x, z-10);
        
        // Approximate slope vector magnitude
        const slope = Math.sqrt(Math.pow(hR-hL, 2) + Math.pow(hD-hU, 2)) / 20.0;

        const color = new THREE.Color();

        // Biome Logic
        if (y > 1200) { 
            color.setHex(0xffffff); // Snow
        } else if (slope > 1.2) { 
            color.setHex(0x505050); // Dark Cliff Rock
        } else if (y < 200) { 
            color.setHex(0x228B22); // Forest Green
            
            // Grass Spawning (Only in low green areas)
            // Use random chance + density map
            if (Math.random() > 0.985) {
                grassDummy.position.set(x + (Math.random()-0.5)*5, y, z + (Math.random()-0.5)*5);
                grassDummy.scale.setScalar(0.8 + Math.random()*0.5);
                grassDummy.rotation.y = Math.random() * Math.PI;
                grassDummy.updateMatrix();
                grassMatrices.push(grassDummy.matrix.clone());
            }
        } else {
            color.setHex(0x5c5038); // Brown/Tundra
        }
        
        // Add some noise to color to remove "banding"
        color.offsetHSL(0, 0, (Math.random() - 0.5) * 0.05);

        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    mesh.position.set(xOffset, 0, zOffset);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    group.add(mesh);

    // Add Grass Batch
    if (grassMatrices.length > 0) {
        const grassMesh = new THREE.InstancedMesh(grassGeo, grassMat, grassMatrices.length);
        for(let k=0; k<grassMatrices.length; k++) {
            grassMesh.setMatrixAt(k, grassMatrices[k]);
        }
        grassMesh.position.set(xOffset, 0, zOffset);
        // Important: Frustum culling can be tricky with InstancedMesh if bounding sphere isn't set, 
        // but for this simple setup it usually defaults to the origin. We'll disable culling for grass to prevent popping.
        grassMesh.frustumCulled = false; 
        scene.add(grassMesh);
    }

    return group;
}

// Generate the 8x8 Grid
for (let x = 0; x < CHUNKS_SIDE; x++) {
    for (let z = 0; z < CHUNKS_SIDE; z++) {
        const xPos = (x * CHUNK_SIZE) - (WORLD_SIZE/2) + (CHUNK_SIZE/2);
        const zPos = (z * CHUNK_SIZE) - (WORLD_SIZE/2) + (CHUNK_SIZE/2);
        scene.add(createChunk(xPos, zPos));
    }
}

// --- PLAYER & CAMERA ---
const players = {};
let myMesh = null;

const state = {
    x: 0, y: 50, z: 0,
    yVel: 0,
    yaw: 0, pitch: 0,
    zoomLevel: 30,
    jumpCount: 0, isGrounded: false,
    dashVel: { x: 0, z: 0 },
    lastDash: 0
};

// Pointer Lock
document.body.addEventListener('click', () => {
    document.body.requestPointerLock();
});

document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === document.body) {
        state.yaw -= e.movementX * 0.002;
        state.pitch -= e.movementY * 0.002;
        // Clamp pitch to avoid flipping over
        state.pitch = Math.max(-Math.PI / 2 + 0.1, Math.min(Math.PI / 2 - 0.1, state.pitch));
    }
});

const keys = {};
document.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space') {
        if (state.isGrounded) { state.yVel = 1.6; state.jumpCount = 1; state.isGrounded = false; }
        else if (state.jumpCount < 2) { state.yVel = 1.4; state.jumpCount = 2; }
    }
    if (e.code === 'KeyQ') { // DASH
        const now = Date.now();
        if (now - state.lastDash > 500) {
            // Dash towards where camera is facing (horizontal only)
            state.dashVel.x = -Math.sin(state.yaw) * 12.0;
            state.dashVel.z = -Math.cos(state.yaw) * 12.0;
            state.lastDash = now;
        }
    }
});
document.addEventListener('keyup', (e) => keys[e.code] = false);

// --- HELPER: PLAYER MESH ---
function createPlayerMesh(data) {
    const group = new THREE.Group();
    const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: data.color }));
    cube.castShadow = true;
    group.add(cube);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 64;
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.roundRect(0,0,256,64,12); ctx.fill();
    ctx.font = "bold 32px Arial"; ctx.fillStyle = "white"; ctx.textAlign="center";
    ctx.fillText(data.name, 128, 42);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
    sprite.scale.set(6, 1.5, 1);
    sprite.position.y = 3;
    group.add(sprite);
    return group;
}

// --- SOCKETS ---
socket.on('currentPlayers', (srvPlayers) => {
    Object.keys(srvPlayers).forEach(id => {
        if(!players[id]) {
            players[id] = createPlayerMesh(srvPlayers[id]);
            scene.add(players[id]);
            if(id === socket.id) myMesh = players[id];
        }
    });
});
socket.on('newPlayer', (d) => { players[d.id] = createPlayerMesh(d.player); scene.add(players[d.id]); });
socket.on('playerMoved', (d) => { if(d.id !== socket.id && players[d.id]) players[d.id].position.set(d.x, d.y, d.z); });
socket.on('playerDisconnected', (id) => { if(players[id]) { scene.remove(players[id]); delete players[id]; }});

// --- MAIN LOOP ---
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const time = clock.getElapsedTime();
    
    // Animate Grass
    grassMat.uniforms.time.value = time;

    if (myMesh) {
        // 1. ZOOM I/O
        if (keys['KeyI']) state.zoomLevel = Math.max(0, state.zoomLevel - 1);
        if (keys['KeyO']) state.zoomLevel = Math.min(200, state.zoomLevel + 1);

        // 2. MOVEMENT (WASD relative to Yaw)
        const sprint = keys['ShiftLeft'] ? 2.5 : 1.0;
        let mx = 0, mz = 0;
        
        // Standard FPS WASD Calculation
        // W moves forward (-z), S moves back (+z)
        if (keys['KeyW']) { mx -= Math.sin(state.yaw); mz -= Math.cos(state.yaw); }
        if (keys['KeyS']) { mx += Math.sin(state.yaw); mz += Math.cos(state.yaw); }
        if (keys['KeyA']) { mx -= Math.sin(state.yaw + Math.PI/2); mz -= Math.cos(state.yaw + Math.PI/2); }
        if (keys['KeyD']) { mx += Math.sin(state.yaw + Math.PI/2); mz += Math.cos(state.yaw + Math.PI/2); }

        if (mx !== 0 || mz !== 0) {
            const len = Math.sqrt(mx*mx + mz*mz);
            state.x += (mx/len) * sprint;
            state.z += (mz/len) * sprint;
            // Face direction of movement
            myMesh.rotation.y = Math.atan2(-mx, -mz); // Flip for mesh facing
        } else {
            // If idle, match camera yaw
            myMesh.rotation.y = state.yaw; // Match camera
        }

        // Apply Dash
        state.x += state.dashVel.x;
        state.z += state.dashVel.z;
        state.dashVel.x *= 0.9; state.dashVel.z *= 0.9;

        // 3. GRAVITY & COLLISION
        state.yVel -= 0.05;
        state.y += state.yVel;

        const groundH = getTerrainHeight(state.x, state.z);
        if (state.y < groundH + 1.0) {
            state.y = groundH + 1.0;
            state.yVel = 0;
            state.isGrounded = true;
            state.jumpCount = 0;
        }

        myMesh.position.set(state.x, state.y, state.z);

        // 4. CAMERA LOGIC
        if (state.zoomLevel < 1) {
            // First Person
            myMesh.visible = false;
            camera.position.set(state.x, state.y + 1, state.z);
            // In FPS, camera rotation is pure yaw/pitch
            camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
        } else {
            // Third Person (Orbit)
            myMesh.visible = true;
            
            // Calculate target camera position
            const cx = state.x + Math.sin(state.yaw) * state.zoomLevel * Math.cos(state.pitch);
            const cz = state.z + Math.cos(state.yaw) * state.zoomLevel * Math.cos(state.pitch);
            const cy = state.y + state.zoomLevel * Math.sin(-state.pitch) + 5; // +5 looks over shoulder

            // Camera Collision Check (Don't clip through mountains)
            // We sample the terrain at the camera's potential position
            const camGroundH = getTerrainHeight(cx, cz);
            const finalCamY = Math.max(cy, camGroundH + 2); // Stay 2 units above ground minimum

            camera.position.set(cx, finalCamY, cz);
            camera.lookAt(state.x, state.y + 2, state.z);
        }
        
        socket.emit('playerMovement', { x: state.x, y: state.y, z: state.z });
    }

    renderer.render(scene, camera);
}
animate();
