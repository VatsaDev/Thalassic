import * as THREE from 'three';

// --- CONFIGURATION ---
const SERVER_URL = window.location.origin; 
const socket = io(SERVER_URL);

// --- SCENE & LIGHTING ---
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 20000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Soft Global Lighting (Like image 2)
scene.add(new THREE.AmbientLight(0xffffff, 0.3));
const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x4d5d27, 0.8); // Sky / Ground mix
scene.add(hemiLight);

const sun = new THREE.DirectionalLight(0xfff5e1, 1.2);
sun.position.set(2000, 3000, 1000);
sun.castShadow = true;
sun.shadow.camera.left = -5000; sun.shadow.camera.right = 5000;
sun.shadow.camera.top = 5000; sun.shadow.camera.bottom = -5000;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun);

// Skybox Gradient
const skyGeo = new THREE.SphereGeometry(15000, 32, 15);
const skyMat = new THREE.ShaderMaterial({
    uniforms: { topColor: { value: new THREE.Color(0x71b3ff) }, bottomColor: { value: new THREE.Color(0xffffff) } },
    vertexShader: `varying vec3 vP; void main() { vP = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 topColor; uniform vec3 bottomColor; varying vec3 vP; void main() { float h = normalize(vP).y; gl_FragColor = vec4(mix(bottomColor, topColor, max(h, 0.0)), 1.0); }`,
    side: THREE.BackSide
});
scene.add(new THREE.Mesh(skyGeo, skyMat));

// --- RIDGED MOUNTAIN ENGINE ---
const WORLD_SIZE = 10000;
const CHUNK_COUNT = 8; // 8x8 = 64 chunks
const CHUNK_SIZE = WORLD_SIZE / CHUNK_COUNT;
const SEGMENTS = 100; // Total polys: (100*100) * 64 = 640k faces

function getTerrainHeight(x, z) {
    const dist = Math.sqrt(x*x + z*z);
    const mask = Math.pow(dist / (WORLD_SIZE/2), 2.0); // Gentle exponential
    
    // Ridged Noise for sharp mountains
    let noise = 0, amp = 1, freq = 0.004;
    for(let i = 0; i < 6; i++) {
        let n = Math.sin(x * freq) * Math.cos(z * freq);
        noise += (1.0 - Math.abs(n)) * amp; // "Ridged" part
        freq *= 2.3; amp *= 0.45;
    }
    return mask * noise * 850; // Final height 1.5km peaks
}

// --- GRASS SHADER ---
const grassMat = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, color: { value: new THREE.Color(0x3e6b26) } },
    vertexShader: `
        varying float vY;
        uniform float time;
        void main() {
            vY = position.y;
            vec3 pos = position;
            if(pos.y > 0.1) {
                pos.x += sin(time * 2.0 + (modelMatrix * vec4(position, 1.0)).x * 0.5) * 0.3 * pos.y;
            }
            gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(pos, 1.0);
        }
    `,
    fragmentShader: `varying float vY; uniform vec3 color; void main() { gl_FragColor = vec4(color * (0.5 + vY), 1.0); }`,
    side: THREE.DoubleSide
});

function createChunk(xO, zO) {
    const geo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, SEGMENTS, SEGMENTS);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    
    for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) + xO, z = pos.getZ(i) + zO;
        const y = getTerrainHeight(x, z);
        pos.setY(i, y);
        const c = new THREE.Color();
        if (y > 900) c.set(0xffffff); // Snow
        else if (y > 400) c.set(0x666666); // Rock
        else if (y > 50) c.set(0x2d4a22); // Deep Forest Green
        else c.set(0x4d5d27); // Valley Grass
        colors[i*3]=c.r; colors[i*3+1]=c.g; colors[i*3+2]=c.b;
        
        // Add grass in low valley patches
        if (y < 40 && Math.random() < 0.015) {
            // Grass logic would go here in an InstancedMesh...
        }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }));
    mesh.position.set(xO, 0, zO);
    mesh.receiveShadow = true;
    return mesh;
}

for(let x = -4; x < 4; x++) for(let z = -4; z < 4; z++) {
    scene.add(createChunk(x * CHUNK_SIZE + CHUNK_SIZE/2, z * CHUNK_SIZE + CHUNK_SIZE/2));
}

// --- PLAYER & CAMERA CONTROL ---
const players = {}; 
let myMesh = null;
const state = { x: 0, y: 10, z: 0, yVel: 0, yaw: 0, pitch: 0.3, zoom: 40, isGrounded: false };

const keys = {};
window.addEventListener('keydown', e => keys[e.code] = true);
window.addEventListener('keyup', e => keys[e.code] = false);

function animate() {
    requestAnimationFrame(animate);
    if (!myMesh) return;

    // Camera Orbit (Arrow Keys)
    if (keys['ArrowLeft']) state.yaw += 0.05;
    if (keys['ArrowRight']) state.yaw -= 0.05;
    if (keys['ArrowUp']) state.pitch = Math.min(1.4, state.pitch + 0.03);
    if (keys['ArrowDown']) state.pitch = Math.max(0.1, state.pitch - 0.03);
    if (keys['KeyI']) state.zoom = Math.max(0, state.zoom - 2);
    if (keys['KeyO']) state.zoom = Math.min(500, state.zoom + 2);

    // Movement (WASD) - Relative to Camera
    const speed = keys['ShiftLeft'] ? 2.5 : 1.0;
    let mx = 0, mz = 0;
    if (keys['KeyW']) { mx += Math.sin(state.yaw); mz += Math.cos(state.yaw); }
    if (keys['KeyS']) { mx -= Math.sin(state.yaw); mz -= Math.cos(state.yaw); }
    if (keys['KeyA']) { mx += Math.sin(state.yaw + Math.PI/2); mz += Math.cos(state.yaw + Math.PI/2); }
    if (keys['KeyD']) { mx -= Math.sin(state.yaw + Math.PI/2); mz -= Math.cos(state.yaw + Math.PI/2); }

    if (mx !== 0 || mz !== 0) {
        const mag = Math.sqrt(mx*mx + mz*mz);
        state.x += (mx/mag) * speed; state.z += (mz/mag) * speed;
    }

    // Jump & Gravity (Cranked for 10km scale)
    if (keys['Space'] && state.isGrounded) { state.yVel = 2.0; state.isGrounded = false; }
    state.yVel -= 0.06;
    state.y += state.yVel;

    const floor = getTerrainHeight(state.x, state.z) + 1.0;
    if (state.y < floor) { state.y = floor; state.yVel = 0; state.isGrounded = true; }

    myMesh.position.set(state.x, state.y, state.z);
    myMesh.rotation.y = state.yaw;

    // Update Camera
    if (state.zoom < 1) { // First Person
        myMesh.visible = false;
        camera.position.set(state.x, state.y + 1, state.z);
        camera.rotation.set(-state.pitch, state.yaw + Math.PI, 0, 'YXZ');
    } else { // Third Person Orbit
        myMesh.visible = true;
        const camX = state.x - Math.sin(state.yaw) * Math.cos(state.pitch) * state.zoom;
        const camZ = state.z - Math.cos(state.yaw) * Math.cos(state.pitch) * state.zoom;
        const camY = state.y + Math.sin(state.pitch) * state.zoom + 5;
        camera.position.set(camX, camY, camZ);
        camera.lookAt(state.x, state.y + 2, state.z);
    }

    grassMat.uniforms.time.value += 0.05;
    socket.emit('playerMovement', { x: state.x, y: state.y, z: state.z });
    renderer.render(scene, camera);
}

// --- NETWORKING (STUB) ---
socket.on('currentPlayers', sp => Object.keys(sp).forEach(id => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2,2,2), new THREE.MeshStandardMaterial({color: sp[id].color}));
    scene.add(mesh); players[id] = mesh; if(id===socket.id) myMesh = mesh;
}));
socket.on('playerMoved', d => { if(d.id !== socket.id && players[d.id]) players[d.id].position.set(d.x, d.y, d.z); });

animate();
