import * as THREE from 'three';

// --- CONFIGURATION ---
// Since we are hosting the files ON the VM, we can just use window.location
// If you run this file locally but want to connect to VM, swap the comments:
const SERVER_URL = window.location.origin; 
// const SERVER_URL = 'http://34.122.221.214:3000'; 

const socket = io(SERVER_URL);

// --- THREE JS SETUP ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB); // Sky blue

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 5, 10);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(10, 20, 10);
scene.add(dirLight);

// --- ENVIRONMENT ---
// Big Green Cube (Ground)
const groundGeo = new THREE.BoxGeometry(50, 1, 50);
const groundMat = new THREE.MeshBasicMaterial({ color: 0x228B22 }); // Forest Green
const ground = new THREE.Mesh(groundGeo, groundMat);
ground.position.y = -0.5;
scene.add(ground);

// --- PLAYER MANAGEMENT ---
const players = {}; // Stores other players meshes
const geometry = new THREE.BoxGeometry(1, 1, 1);

function createNametag(text) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 64;
    
    // Background (Optional, Roblox style usually has none or semi-transparent)
    ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
    ctx.fillRect(0, 0, 256, 64);

    // Text
    ctx.font = "bold 24px Arial";
    ctx.fillStyle = "white";
    ctx.textAlign = "center";
    ctx.fillText(text, 128, 40);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(spriteMaterial);
    
    sprite.scale.set(4, 1, 1);
    sprite.position.y = 1.2; // Float above head
    return sprite;
}

function addPlayer(id, data) {
    const material = new THREE.MeshStandardMaterial({ color: data.color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(data.x, data.y, data.z);
    
    // Add Nametag
    const nametag = createNametag(data.name);
    mesh.add(nametag);

    scene.add(mesh);
    players[id] = mesh;
}

// --- SOCKET EVENTS ---
socket.on('currentPlayers', (serverPlayers) => {
    Object.keys(serverPlayers).forEach((id) => {
        if (id === socket.id) return; // Don't draw ourselves yet (or handle differently)
        addPlayer(id, serverPlayers[id]);
    });
});

socket.on('newPlayer', (data) => {
    addPlayer(data.id, data.player);
});

socket.on('playerMoved', (data) => {
    if (players[data.id]) {
        players[data.id].position.set(data.x, data.y, data.z);
    }
});

socket.on('playerDisconnected', (id) => {
    if (players[id]) {
        scene.remove(players[id]);
        delete players[id];
    }
});

// --- MY PLAYER CONTROLS ---
const speed = 0.1;
const myPosition = { x: 0, y: 0.5, z: 0 }; // Local tracking

// Inputs
const keys = {};
document.addEventListener('keydown', (e) => keys[e.code] = true);
document.addEventListener('keyup', (e) => keys[e.code] = false);

// --- GAME LOOP ---
function animate() {
    requestAnimationFrame(animate);

    // Movement Logic
    let moved = false;
    if (keys['KeyW'] || keys['ArrowUp']) { myPosition.z -= speed; moved = true; }
    if (keys['KeyS'] || keys['ArrowDown']) { myPosition.z += speed; moved = true; }
    if (keys['KeyA'] || keys['ArrowLeft']) { myPosition.x -= speed; moved = true; }
    if (keys['KeyD'] || keys['ArrowRight']) { myPosition.x += speed; moved = true; }

    // Update Camera to follow "me" (Optional: create a mesh for self if you want to see yourself)
    camera.position.x = myPosition.x;
    camera.position.z = myPosition.z + 5;
    camera.lookAt(myPosition.x, 0.5, myPosition.z);

    if (moved) {
        socket.emit('playerMovement', { x: myPosition.x, y: 0.5, z: myPosition.z });
    }

    renderer.render(scene, camera);
}

animate();
