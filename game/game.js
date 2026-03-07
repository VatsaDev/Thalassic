import * as THREE from 'three';

// --- CONFIGURATION ---
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL);

// --- SCENE SETUP ---
const scene = new THREE.Scene();
// 1. SKYBOX & LIGHTING (Warm, Vibrant "Asset Pack" Style)
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
const skyGeo = new THREE.SphereGeometry(15000, 32, 15);
const skyMat = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: {
        topColor: { value: new THREE.Color(0x3399ff) }, // Deep Sky Blue
        bottomColor: { value: new THREE.Color(0xffeebb) } // Warm Sunset Horizon
    },
    side: THREE.BackSide
});
scene.add(new THREE.Mesh(skyGeo, skyMat));

// Fog to blend mountains into sky
scene.fog = new THREE.Fog(0xffeebb, 500, 9000);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 20000);
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true }); // Log depth for huge draw distance
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // Better colors
renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);

// Lighting
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
scene.add(hemiLight);

const sun = new THREE.DirectionalLight(0xfff0dd, 1.5);
sun.position.set(1000, 3000, 1000);
sun.castShadow = true;
// Optimize Shadow Map for Giant World
sun.shadow.camera.left = -3000; sun.shadow.camera.right = 3000;
sun.shadow.camera.top = 3000; sun.shadow.camera.bottom = -3000;
sun.shadow.camera.far = 10000;
sun.shadow.bias = -0.0005;
sun.shadow.mapSize.set(4096, 4096);
scene.add(sun);

// --- TERRAIN GENERATION (EROSION & RIDGE NOISE) ---
const WORLD_SIZE = 10000; // 10km
const CHUNKS_SIDE = 8;    // 8x8 = 64 Chunks
const CHUNK_SIZE = WORLD_SIZE / CHUNKS_SIDE; // 1250 per chunk
const SEGMENTS = 100;     // 100x100 verts per chunk (High Res)

// Pseudo-Random Noise
function hash(n) { return Math.sin(n) * 43758.5453123; }
function noise(x, z) {
    const fx = Math.floor(x); const fz = Math.floor(z);
    const cx = x - fx; const cz = z - fz;
    // Simple interpolation would go here, simplified for brevity in single file
    return Math.sin(x/5) * Math.cos(z/5); // Placeholder for complex simplex
}

// "Ridge Noise" - Creates sharp mountain peaks (Erosion simulation)
function getTerrainHeight(x, z) {
    const dist = Math.sqrt(x*x + z*z);
    
    // 1. Exponential Mask (Flat center, walls at edge)
    const maxDist = WORLD_SIZE / 2.2;
    let mask = Math.pow(Math.min(1.0, dist / maxDist), 2.5);

    // 2. Ridge FBM
    let h = 0;
    let amp = 1;
    let freq = 0.003;
    
    for(let i = 0; i < 5; i++) {
        // Absolute value of sin creates sharp "creases" (Ridges)
        let n = 1.0 - Math.abs(Math.sin(x * freq) + Math.cos(z * freq)) * 0.5;
        // Square it to make ridges sharper
        n = n * n; 
        h += n * amp;
        
        freq *= 2.1;
        amp *= 0.45;
    }

    // 3. Domain Warping (Twists the terrain to look organic)
    const warp = Math.sin(x * 0.001) * 100;

    return mask * (h * 1600) + (warp * mask); // Scale up to 1.6km height
}

// --- GRASS SHADER SYSTEM ---
const grassVertexShader = `
    varying vec2 vUv;
    uniform float time;
    void main() {
        vUv = uv;
        vec4 pos = vec4(position, 1.0);
        
        // Sway Logic (Wind)
        float sway = sin(time * 2.0 + instanceMatrix[3][0] * 0.5) * 0.3; // Random phase based on X pos
        // Only sway the top of the grass blade (y > 0)
        if (pos.y > 0.5) {
            pos.x += sway;
        }

        // Instance Matrix handles placement
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * pos;
    }
`;
const grassFragmentShader = `
    varying vec2 vUv;
    void main() {
        // Deep Green Gradient
        vec3 color = mix(vec3(0.1, 0.3, 0.1), vec3(0.4, 0.8, 0.2), vUv.y);
        gl_FragColor = vec4(color, 1.0);
    }
`;
const grassMat = new THREE.ShaderMaterial({
    vertexShader: grassVertexShader,
    fragmentShader: grassFragmentShader,
    uniforms: { time: { value: 0 } },
    side: THREE.DoubleSide
});
const grassGeo = new THREE.PlaneGeometry(1, 2); // Simple blade

// --- CHUNK GENERATION ---
function createChunk(xOffset, zOffset) {
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    
    // Arrays for grass placement
    const grassDummy = new THREE.Object3D();
    const grassMatrices = [];

    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + xOffset;
        const z = pos.getZ(i) + zOffset;
        const y = getTerrainHeight(x, z);
        pos.setY(i, y);

        // --- SLOPE CALCULATION ---
        // Calc simplified slope by checking height of next vertex (approx)
        const neighborY = getTerrainHeight(x + 5, z);
        const slope = Math.abs(y - neighborY);

        const color = new THREE.Color();
        
        // Texturing Logic
        if (y > 1100) { // High Peaks
            color.setHex(0xffffff); // Snow
        } else if (slope > 1.5) { // Steep = Rock
            color.setHex(0x555555); // Grey Rock
        } else if (y < 200 && slope < 0.5) { // Low & Flat = Grass
            // "Deeper" Grass Color
            const noiseVar = Math.sin(x*0.1) * Math.cos(z*0.1); // Color variation
            color.setHex(0x2d5a27); // Deep Green
            color.lerp(new THREE.Color(0x3a6b32), noiseVar * 0.5);

            // Chance to spawn grass blade (only in center valley to save FPS)
            if (Math.random() > 0.96 && Math.abs(x) < 3000 && Math.abs(z) < 3000) {
                grassDummy.position.set(x + (Math.random()-0.5)*10, y, z + (Math.random()-0.5)*10);
                grassDummy.scale.set(1 + Math.random(), 1 + Math.random(), 1);
                grassDummy.rotation.y = Math.random() * Math.PI;
                grassDummy.updateMatrix();
                grassMatrices.push(grassDummy.matrix.clone());
            }

        } else {
            color.setHex(0x605538); // Dirt/Tundra
        }

        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const group = new THREE.Group();
    const terrainMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ 
        vertexColors: true, 
        roughness: 0.9,
        flatShading: true // Requested Low Poly Look
    }));
    terrainMesh.position.set(xOffset, 0, zOffset);
    terrainMesh.receiveShadow = true;
    terrainMesh.castShadow = true;
    group.add(terrainMesh);

    // Add Grass InstancedMesh
    if (grassMatrices.length > 0) {
        const mesh = new THREE.InstancedMesh(grassGeo, grassMat, grassMatrices.length);
        for(let k=0; k<grassMatrices.length; k++) {
            mesh.setMatrixAt(k, grassMatrices[k]);
        }
        mesh.position.set(xOffset, 0, zOffset); // Relative offset not needed if positions were absolute, but safe
        scene.add(mesh); // Add directly to scene to avoid parenting offset issues
    }

    return group;
}

// Generate 8x8 Grid (64 Chunks)
const offset = (WORLD_SIZE / 2) - (CHUNK_SIZE / 2);
for(let x = 0; x < CHUNKS_SIDE; x++) {
    for(let z = 0; z < CHUNKS_SIDE; z++) {
        const xPos = (x * CHUNK_SIZE) - (WORLD_SIZE/2) + (CHUNK_SIZE/2);
        const zPos = (z * CHUNK_SIZE) - (WORLD_SIZE/2) + (CHUNK_SIZE/2);
        scene.add(createChunk(xPos, zPos));
    }
}

// --- PLAYER SYSTEM ---
const players = {}; 
let myMesh = null;

const state = {
    x: 0, y: 50, z: 0,
    yVel: 0, 
    // Camera Angles
    camYaw: 0, 
    camPitch: 0.3,
    
    // Mechanics
    jumpCount: 0, isGrounded: false,
    lastDash: 0, dashVel: { x: 0, z: 0 }
};

// --- CONTROLS (WASD MOVE, ARROWS CAM) ---
const keys = {};
document.addEventListener('keydown', (e) => {
    keys[e.code] = true;
    // Jump
    if (e.code === 'Space') {
        if (state.isGrounded) { state.yVel = 1.8; state.jumpCount = 1; state.isGrounded = false; } // Stronger Jump
        else if (state.jumpCount < 2) { state.yVel = 1.4; state.jumpCount = 2; }
    }
    // Dash
    if (e.code === 'KeyQ') {
        const now = Date.now();
        if (now - state.lastDash > 500) {
            // Dash in direction of camera facing
            state.dashVel.x = Math.sin(state.camYaw) * 12.0; 
            state.dashVel.z = Math.cos(state.camYaw) * 12.0;
            state.lastDash = now;
        }
    }
});
document.addEventListener('keyup', (e) => keys[e.code] = false);

// --- HELPERS ---
function createPlayerMesh(data) {
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshStandardMaterial({ color: data.color }));
    body.castShadow = true;
    group.add(body);
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height = 64;
    ctx.fillStyle = "rgba(0,0,0,0.7)"; ctx.roundRect(0,0,256,64,10); ctx.fill();
    ctx.font = "bold 30px Arial"; ctx.fillStyle = "white"; ctx.textAlign="center";
    ctx.fillText(data.name, 128, 42);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
    sprite.scale.set(6, 1.5, 1);
    sprite.position.y = 3;
    group.add(sprite);
    return group;
}

// --- NETWORKING ---
socket.on('currentPlayers', (sP) => {
    Object.keys(sP).forEach(id => {
        if (!players[id]) {
            players[id] = createPlayerMesh(sP[id]);
            scene.add(players[id]);
            if (id === socket.id) myMesh = players[id];
        }
    });
});
socket.on('newPlayer', (d) => { players[d.id] = createPlayerMesh(d.player); scene.add(players[d.id]); });
socket.on('playerMoved', (d) => { if (d.id !== socket.id && players[d.id]) players[d.id].position.set(d.x, d.y, d.z); });
socket.on('playerDisconnected', (id) => { if(players[id]) { scene.remove(players[id]); delete players[id]; } });

// --- MAIN LOOP ---
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const time = clock.getElapsedTime();
    
    // Update Wind Shader
    grassMat.uniforms.time.value = time;

    if (myMesh) {
        // 1. CAMERA ORBIT (ARROWS)
        if (keys['ArrowLeft']) state.camYaw += 0.04;
        if (keys['ArrowRight']) state.camYaw -= 0.04;
        if (keys['ArrowUp']) state.camPitch = Math.min(Math.PI/2.5, state.camPitch + 0.03);
        if (keys['ArrowDown']) state.camPitch = Math.max(0.1, state.camPitch - 0.03);

        // 2. MOVEMENT (WASD - Relative to Camera)
        let moveX = 0; 
        let moveZ = 0;
        const sprint = keys['ShiftLeft'] ? 2.0 : 0.8;

        if (keys['KeyW']) { moveX += Math.sin(state.camYaw); moveZ += Math.cos(state.camYaw); }
        if (keys['KeyS']) { moveX -= Math.sin(state.camYaw); moveZ -= Math.cos(state.camYaw); }
        if (keys['KeyA']) { moveX += Math.sin(state.camYaw + Math.PI/2); moveZ += Math.cos(state.camYaw + Math.PI/2); }
        if (keys['KeyD']) { moveX -= Math.sin(state.camYaw + Math.PI/2); moveZ -= Math.cos(state.camYaw + Math.PI/2); }

        // Normalize vector so diagonal isn't faster
        if (moveX !== 0 || moveZ !== 0) {
            const len = Math.sqrt(moveX*moveX + moveZ*moveZ);
            state.x += (moveX / len) * sprint;
            state.z += (moveZ / len) * sprint;
            
            // Rotate player mesh to face movement direction
            myMesh.rotation.y = Math.atan2(moveX, moveZ);
        }

        // Apply Dash
        state.x += state.dashVel.x; 
        state.z += state.dashVel.z;
        state.dashVel.x *= 0.9; state.dashVel.z *= 0.9;

        // 3. PHYSICS
        state.yVel -= 0.06; // Gravity
        state.y += state.yVel;

        const terrainH = getTerrainHeight(state.x, state.z);
        if (state.y < terrainH + 1.0) {
            state.y = terrainH + 1.0;
            state.yVel = 0;
            state.isGrounded = true;
            state.jumpCount = 0;
        }

        myMesh.position.set(state.x, state.y, state.z);

        // 4. CAMERA FOLLOW
        const zoom = 40;
        camera.position.set(
            state.x - Math.sin(state.camYaw) * zoom * Math.cos(state.camPitch),
            state.y + zoom * Math.sin(state.camPitch),
            state.z - Math.cos(state.camYaw) * zoom * Math.cos(state.camPitch)
        );
        camera.lookAt(state.x, state.y + 5, state.z);

        socket.emit('playerMovement', { x: state.x, y: state.y, z: state.z });
    }

    renderer.render(scene, camera);
}
animate();
