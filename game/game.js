import * as THREE from 'three';
import { createNoise2D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';

// --- CONFIGURATION ---
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL);

// --- SCENE SETUP ---
const scene = new THREE.Scene();
// Sky Color: Bright Anime Blue
scene.background = new THREE.Color(0x87CEEB);
scene.fog = new THREE.Fog(0x87CEEB, 200, 2000);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace; // Correct color management
document.body.appendChild(renderer.domElement);

// --- LIGHTING (The "RPG" Look) ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6); // High ambient for "anime" look
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xfff5e6, 1.5); // Warm sun
sunLight.position.set(500, 1000, 500);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far = 2000;
const d = 1000;
sunLight.shadow.camera.left = -d; sunLight.shadow.camera.right = d;
sunLight.shadow.camera.top = d; sunLight.shadow.camera.bottom = -d;
sunLight.shadow.bias = -0.0005; // Removes "black blob" artifacts
scene.add(sunLight);

// Visible Sun Mesh
const sunGeo = new THREE.SphereGeometry(50, 32, 32);
const sunMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
const sunMesh = new THREE.Mesh(sunGeo, sunMat);
sunMesh.position.copy(sunLight.position).normalize().multiplyScalar(1800);
scene.add(sunMesh);

// --- NOISE GENERATION (Standard Library) ---
const noise2D = createNoise2D();

// FBM (Fractal Brownian Motion) for "Mountainous" look
function getTerrainHeight(x, z) {
    let y = 0;
    let amp = 150; // Base height
    let freq = 0.002; // Base spread

    // Layer 1: General rolling hills
    y += noise2D(x * freq, z * freq) * amp;

    // Layer 2: Detail
    y += noise2D(x * freq * 2.5, z * freq * 2.5) * amp * 0.5;

    // Layer 3: Rocky bumps
    y += noise2D(x * freq * 10, z * freq * 10) * amp * 0.1;

    // Mountain Mask (Exponential) - Forces edges to be mountains
    const dist = Math.sqrt(x*x + z*z);
    const worldRadius = 2000;
    const mask = Math.pow(dist / worldRadius, 4); 
    
    // Add massive peaks at edges
    const mountains = Math.abs(noise2D(x * 0.0005, z * 0.0005)) * 1500;
    
    return y + (mountains * mask);
}

// --- SHADERS FOR WIND ---
const windVertexShader = `
    varying vec2 vUv;
    varying vec3 vNormal;
    uniform float time;
    uniform float swayPower; // 1.0 for grass, 0.1 for trees

    void main() {
        vUv = uv;
        vNormal = normal;
        vec4 pos = vec4(position, 1.0);
        
        // Simple wind: move X/Z based on time and height
        float wind = sin(time + instanceMatrix[3][0] * 0.05 + instanceMatrix[3][2] * 0.05);
        
        // Apply only to top vertices (y > 0)
        float heightFactor = max(0.0, pos.y); 
        pos.x += wind * swayPower * heightFactor * 0.2;
        
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * pos;
    }
`;

const simpleFragmentShader = `
    varying vec2 vUv;
    varying vec3 vNormal;
    uniform vec3 color;
    void main() {
        // Simple lighting calculation for flat look
        vec3 light = normalize(vec3(0.5, 1.0, 0.5));
        float diff = dot(vNormal, light);
        diff = max(0.0, diff);
        
        vec3 finalColor = color * (0.6 + 0.4 * diff); // Ambient + Diffuse
        gl_FragColor = vec4(finalColor, 1.0);
    }
`;

// --- ASSETS: GRASS & TREES ---

// 1. Grass Asset
const grassGeo = new THREE.PlaneGeometry(1.5, 1.5);
grassGeo.translate(0, 0.75, 0); // Pivot at bottom
const grassMat = new THREE.ShaderMaterial({
    vertexShader: windVertexShader,
    fragmentShader: simpleFragmentShader,
    uniforms: {
        time: { value: 0 },
        swayPower: { value: 1.0 }, // Full sway
        color: { value: new THREE.Color(0x55aa55) }
    },
    side: THREE.DoubleSide
});

// 2. Tree Asset (Low Poly Pine)
const treeGeo = new THREE.CylinderGeometry(0, 1.5, 5, 5); // Cone foliage
treeGeo.translate(0, 2.5, 0);
const trunkGeo = new THREE.CylinderGeometry(0.5, 0.5, 2, 5); // Trunk
trunkGeo.translate(0, 1, 0);
// Merge logic (simplified: separate meshes for colors)
const treeFoliageMat = new THREE.ShaderMaterial({
    vertexShader: windVertexShader,
    fragmentShader: simpleFragmentShader,
    uniforms: {
        time: { value: 0 },
        swayPower: { value: 0.1 }, // Gentle sway
        color: { value: new THREE.Color(0x228b22) }
    },
    flatShading: true
});
const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x8B4513, flatShading: true });


// --- CHUNK GENERATION ---
const CHUNK_SIZE = 100;
const GRID_SIZE = 10; // 10x10 chunks
const SEGMENTS = 20;

function createChunk(xOff, zOff) {
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    
    // Arrays for Instancing
    const grassMatrices = [];
    const treeMatrices = [];
    const dummy = new THREE.Object3D();

    // 1. Deform Terrain
    for(let i=0; i<pos.count; i++){
        const x = pos.getX(i) + xOff;
        const z = pos.getZ(i) + zOff;
        const y = getTerrainHeight(x, z);
        pos.setY(i, y);

        // 2. Place Vegetation (Height check)
        // Trees: Rare, lower heights
        if (y < 80 && Math.random() > 0.99) {
            dummy.position.set(x, y, z);
            dummy.scale.setScalar(1.5 + Math.random());
            dummy.rotation.y = Math.random() * Math.PI;
            dummy.updateMatrix();
            treeMatrices.push(dummy.matrix.clone());
        }
        // Grass: Common, lower heights
        else if (y < 50 && Math.random() > 0.8) {
            dummy.position.set(x, y, z);
            dummy.scale.setScalar(1);
            dummy.rotation.y = Math.random() * Math.PI;
            dummy.updateMatrix();
            grassMatrices.push(dummy.matrix.clone());
        }
    }
    
    geo.computeVertexNormals();

    const group = new THREE.Group();
    // Ground Mesh
    const groundMat = new THREE.MeshStandardMaterial({ 
        color: 0x44aa44, // Bright Green
        roughness: 0.8,
        flatShading: true
    });
    const ground = new THREE.Mesh(geo, groundMat);
    ground.position.set(xOff, 0, zOff);
    ground.receiveShadow = true;
    ground.castShadow = true;
    group.add(ground);

    // Instanced Grass
    if (grassMatrices.length > 0) {
        const iGrass = new THREE.InstancedMesh(grassGeo, grassMat, grassMatrices.length);
        for(let k=0; k<grassMatrices.length; k++) iGrass.setMatrixAt(k, grassMatrices[k]);
        iGrass.position.set(xOff, 0, zOff);
        iGrass.frustumCulled = false; // Prevent popping
        group.add(iGrass);
    }

    // Instanced Trees (Foliage Only for simplicity in ShaderMaterial)
    if (treeMatrices.length > 0) {
        const iTree = new THREE.InstancedMesh(treeGeo, treeFoliageMat, treeMatrices.length);
        const iTrunk = new THREE.InstancedMesh(trunkGeo, treeTrunkMat, treeMatrices.length);
        
        for(let k=0; k<treeMatrices.length; k++) {
            iTree.setMatrixAt(k, treeMatrices[k]);
            iTrunk.setMatrixAt(k, treeMatrices[k]);
        }
        iTree.position.set(xOff, 0, zOff);
        iTrunk.position.set(xOff, 0, zOff);
        iTree.frustumCulled = false;
        iTrunk.frustumCulled = false;
        
        group.add(iTree);
        group.add(iTrunk);
    }

    return group;
}

// Generate World
const worldOffset = (GRID_SIZE * CHUNK_SIZE) / 2;
for(let x=0; x<GRID_SIZE; x++){
    for(let z=0; z<GRID_SIZE; z++){
        const xp = (x * CHUNK_SIZE) - worldOffset;
        const zp = (z * CHUNK_SIZE) - worldOffset;
        scene.add(createChunk(xp, zp));
    }
}

// --- PLAYER ---
const players = {};
let myMesh = null;
const state = {
    x: 0, y: 50, z: 0,
    yVel: 0, yaw: 0, pitch: 0,
    zoom: 20, isGrounded: false, jumpCount: 0,
    dashVel: { x:0, z:0 }, lastDash: 0
};

// --- INPUTS ---
const keys = {};
document.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'Space') {
        if(state.isGrounded) { state.yVel = 1.0; state.isGrounded = false; state.jumpCount = 1; }
        else if(state.jumpCount < 2) { state.yVel = 0.8; state.jumpCount = 2; }
    }
    if (e.code === 'KeyQ' && Date.now() - state.lastDash > 500) {
        state.dashVel.x = -Math.sin(state.yaw) * 8;
        state.dashVel.z = -Math.cos(state.yaw) * 8;
        state.lastDash = Date.now();
    }
});
document.addEventListener('keyup', e => keys[e.code] = false);

// Pointer Lock
document.addEventListener('click', () => document.body.requestPointerLock());
document.addEventListener('mousemove', e => {
    if(document.pointerLockElement){
        state.yaw -= e.movementX * 0.002;
        state.pitch -= e.movementY * 0.002;
        state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch));
    }
});

// Helper
function createPlayer(data) {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5,1.5,1.5), new THREE.MeshStandardMaterial({color:data.color}));
    mesh.castShadow = true;
    g.add(mesh);
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256; canvas.height=64;
    ctx.fillStyle="rgba(0,0,0,0.5)"; ctx.fillRect(0,0,256,64);
    ctx.font="30px Arial"; ctx.fillStyle="white"; ctx.textAlign="center";
    ctx.fillText(data.name, 128,42);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(canvas)}));
    s.scale.set(4,1,1); s.position.y=2;
    g.add(s);
    return g;
}

// Net
socket.on('currentPlayers', p => {
    Object.keys(p).forEach(id=>{
        if(!players[id]) { players[id]=createPlayer(p[id]); scene.add(players[id]); if(id===socket.id) myMesh=players[id]; }
    });
});
socket.on('newPlayer', d => { players[d.id]=createPlayer(d.player); scene.add(players[d.id]); });
socket.on('playerMoved', d => { if(players[d.id] && d.id!==socket.id) players[d.id].position.set(d.x,d.y,d.z); });
socket.on('playerDisconnected', id => { if(players[id]) { scene.remove(players[id]); delete players[id]; } });

// Loop
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    
    // Update Shader Time
    grassMat.uniforms.time.value = t;
    treeFoliageMat.uniforms.time.value = t;

    if (myMesh) {
        if(keys['KeyI']) state.zoom -= 1;
        if(keys['KeyO']) state.zoom += 1;
        state.zoom = Math.max(0, Math.min(50, state.zoom));

        // Move
        let mx=0, mz=0;
        if(keys['KeyW']) { mx -= Math.sin(state.yaw); mz -= Math.cos(state.yaw); }
        if(keys['KeyS']) { mx += Math.sin(state.yaw); mz += Math.cos(state.yaw); }
        if(keys['KeyA']) { mx -= Math.sin(state.yaw + 1.57); mz -= Math.cos(state.yaw + 1.57); }
        if(keys['KeyD']) { mx += Math.sin(state.yaw + 1.57); mz += Math.cos(state.yaw + 1.57); }

        if(mx||mz) {
            const l = Math.sqrt(mx*mx+mz*mz);
            state.x += (mx/l)*0.6; state.z += (mz/l)*0.6;
            myMesh.rotation.y = Math.atan2(-mx, -mz);
        }
        
        state.x += state.dashVel.x; state.z += state.dashVel.z;
        state.dashVel.x *= 0.9; state.dashVel.z *= 0.9;

        // Phys
        state.yVel -= 0.03;
        state.y += state.yVel;
        const h = getTerrainHeight(state.x, state.z) + 0.75;
        if(state.y < h) { state.y = h; state.yVel=0; state.isGrounded=true; state.jumpCount=0; }

        myMesh.position.set(state.x, state.y, state.z);

        // Cam
        if(state.zoom < 1) {
            myMesh.visible = false;
            camera.position.set(state.x, state.y+0.8, state.z);
            camera.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
        } else {
            myMesh.visible = true;
            const cy = state.y + 2 + state.zoom * Math.sin(-state.pitch + 0.5);
            const cx = state.x + Math.sin(state.yaw) * state.zoom * Math.cos(state.pitch);
            const cz = state.z + Math.cos(state.yaw) * state.zoom * Math.cos(state.pitch);
            camera.position.set(cx, cy, cz);
            camera.lookAt(state.x, state.y+1, state.z);
        }
        
        socket.emit('playerMovement', {x:state.x, y:state.y, z:state.z});
    }
    renderer.render(scene, camera);
}
animate();
