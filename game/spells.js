import * as THREE from 'three';

// Holds live spell objects/particles in the scene
export const activeSpells = [];

// Spell definitions detailing cost, damage, and casting function
export const SpellRegistry = {
    "BLOOD DRAIN": { cost: 15, cooldown: 0.5, cast: castBloodDrain, damage: 10 },
    "CRIMSON SPIKES": { cost: 30, cooldown: 0.8, cast: castCrimsonSpikes, damage: 25 },
    "VAMPIRIC SWARM": { cost: 60, cooldown: 2.0, cast: castVampiricSwarm, damage: 40 },

    "THORN WHIP": { cost: 10, cooldown: 0.4, cast: castThornWhip, damage: 15 },
    "ENTANGLE": { cost: 35, cooldown: 1.5, cast: castEntangle, damage: 10 },
    "NATURE'S WRATH": { cost: 70, cooldown: 3.0, cast: castNaturesWrath, damage: 50 },

    "GALE BLAST": { cost: 15, cooldown: 0.5, cast: castGaleBlast, damage: 15 },
    "TORNADO": { cost: 40, cooldown: 1.5, cast: castTornado, damage: 30 },
    "WIND SHEAR": { cost: 55, cooldown: 2.0, cast: castWindShear, damage: 45 },

    "WATER BALL": { cost: 10, cooldown: 0.5, cast: castWaterBall, damage: 15 },
    "FROST NOVA": { cost: 40, cooldown: 1.5, cast: castFrostNova, damage: 20 },
    "TSUNAMI": { cost: 80, cooldown: 3.0, cast: castTsunami, damage: 60 },

    "ARCANE MISSILES": { cost: 20, cooldown: 1.0, cast: castArcaneMissiles, damage: 10 },
    "MANA RIFT": { cost: 50, cooldown: 3.0, cast: castManaRift, damage: 0 },
    "MAGIC BURST": { cost: 75, cooldown: 2.0, cast: castMagicBurst, damage: 55 },

    "FIREBALL": { cost: 25, cooldown: 0.8, cast: castFireball, damage: 40 },
    "FLAME BREATH": { cost: 55, cooldown: 1.5, cast: castFlameBreath, damage: 5 }, // per particle
    "FIRE SPEARS": { cost: 75, cooldown: 3.0, cast: castFireSpears, damage: 20 }, // cloud damage (low)
    "FIRE SPEARS_RAIN": { damage: 60 } // Bolt damage
};

export function updateSpells(dt, scene, players = {}) {
    for (let i = activeSpells.length - 1; i >= 0; i--) {
        const spell = activeSpells[i];
        if (spell.update(dt, players)) {
            // Returns true when spell dies/expires
            if (spell.mesh) scene.remove(spell.mesh);
            if (spell.light) scene.remove(spell.light);
            if (spell.parts) {
                for (let p of spell.parts) scene.remove(p.mesh);
            }
            activeSpells.splice(i, 1);
        }
    }
}

// ==========================================
// BLOOD WARLOCK SPELLS (0)
// ==========================================
function castBloodDrain(scene, pos, dir, ownerId) {
    // Blood Eruption: Frost-nova style burst of blood shards in cast direction
    for (let i = 0; i < 40; i++) {
        const angle = (i / 40) * Math.PI * 2;
        const outDir = new THREE.Vector3(
            dir.x + Math.cos(angle) * 0.6,
            0.2,
            dir.z + Math.sin(angle) * 0.6
        ).normalize();

        const geo = new THREE.ConeGeometry(1.5, 8, 4);
        geo.translate(0, 4, 0);
        const mat = new THREE.MeshBasicMaterial({ color: 0xcc0000, transparent: true, opacity: 0.9 });
        const mesh = new THREE.Mesh(geo, mat);

        mesh.position.copy(pos).add(outDir.clone().multiplyScalar(4));
        mesh.lookAt(mesh.position.clone().add(outDir));
        mesh.rotateX(Math.PI / 4);
        scene.add(mesh);

        activeSpells.push({
            mesh: mesh,
            ownerId: ownerId,
            spellName: "BLOOD DRAIN",
            life: 1.5,
            type: "radius",
            radius: 8,
            vel: outDir.multiplyScalar(80 + Math.random() * 30),
            update: function(dt) {
                this.life -= dt;
                this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
                this.mesh.scale.setScalar(this.life);
                if (this.life < 0.4) this.mesh.material.opacity = this.life * 2.5;
                return this.life <= 0;
            }
        });
    }
}

function castCrimsonSpikes(scene, pos, dir, ownerId) {
    const groundY = pos.y - 2;
    for (let i = 0; i < 15; i++) {
        setTimeout(() => {
            const geo = new THREE.ConeGeometry(8, 40, 4);
            geo.translate(0, 20, 0);
            
            const mat = new THREE.MeshBasicMaterial({ color: 0x880000 });
            const mesh = new THREE.Mesh(geo, mat);
            
            mesh.position.copy(pos).add(dir.clone().multiplyScalar(10 + i * 15));
            mesh.position.setY(groundY - 40);
            scene.add(mesh);

            activeSpells.push({
                mesh: mesh,
                ownerId: ownerId,
                spellName: "CRIMSON SPIKES",
                life: 3.0,
                type: "box",
                size: new THREE.Vector3(20, 50, 20),
                growth: 0,
                update: function(dt) {
                    this.life -= dt;
                    if (this.growth < 1.0) {
                        this.growth += dt * 6;
                        this.mesh.position.y += dt * 150;
                    } else if (this.life < 0.8) {
                        this.mesh.position.y -= dt * 60;
                    }
                    return this.life <= 0;
                }
            });
        }, i * 60);
    }
}

function castVampiricSwarm(scene, pos, dir, ownerId) {
    const particles = [];
    const rootPos = pos.clone().add(dir.clone().multiplyScalar(30));

    for (let i = 0; i < 60; i++) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
        mesh.position.copy(rootPos).add(new THREE.Vector3((Math.random()-0.5)*20, (Math.random()-0.5)*20, (Math.random()-0.5)*20));
        scene.add(mesh);
        particles.push({ mesh, vel: new THREE.Vector3((Math.random()-0.5)*40, (Math.random()-0.5)*40, (Math.random()-0.5)*40) });
    }

    activeSpells.push({
        parts: particles,
        ownerId: ownerId,
        spellName: "VAMPIRIC SWARM",
        life: 4.0,
        type: "radius", // game.js will check mesh positions for swarm
        mesh: particles[0].mesh, // representative mesh for location-based damage
        radius: 25,
        update: function(dt) {
            this.life -= dt;
            for (let p of this.parts) {
                p.vel.add(new THREE.Vector3((Math.random()-0.5)*80 * dt, (Math.random()-0.5)*80 * dt, (Math.random()-0.5)*80 * dt));
                p.mesh.position.add(p.vel.clone().multiplyScalar(dt));
                const toCenter = rootPos.clone().sub(p.mesh.position);
                p.vel.add(toCenter.multiplyScalar(dt * 3));
            }
            if (this.life <= 0) {
                for (let p of this.parts) scene.remove(p.mesh);
                return true;
            }
            return false;
        }
    });
}

// ==========================================
// NATURE DRUID SPELLS (1)
// ==========================================
function castThornWhip(scene, pos, dir, ownerId) {
    // Thornbreak: Frost-nova style burst of thorn shards in cast direction
    for (let i = 0; i < 35; i++) {
        const angle = (i / 35) * Math.PI * 2;
        const outDir = new THREE.Vector3(
            dir.x + Math.cos(angle) * 0.5,
            0.1,
            dir.z + Math.sin(angle) * 0.5
        ).normalize();

        const geo = new THREE.ConeGeometry(1.0, 6, 4);
        geo.translate(0, 3, 0);
        const mat = new THREE.MeshBasicMaterial({ color: 0x225511 });
        const mesh = new THREE.Mesh(geo, mat);

        mesh.position.copy(pos).add(outDir.clone().multiplyScalar(5));
        mesh.lookAt(mesh.position.clone().add(outDir));
        mesh.rotateX(Math.PI / 4);
        scene.add(mesh);

        activeSpells.push({
            mesh: mesh,
            ownerId: ownerId,
            spellName: "THORN WHIP",
            life: 1.8,
            type: "radius",
            radius: 8,
            vel: outDir.multiplyScalar(70 + Math.random() * 25),
            update: function(dt) {
                this.life -= dt;
                this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
                this.mesh.scale.setScalar(this.life * 0.8);
                return this.life <= 0;
            }
        });
    }
}

function castEntangle(scene, pos, dir, ownerId) {
    // Bramble Wall: 10x longer, 5x larger
    const targetPos = pos.clone().add(dir.clone().multiplyScalar(25));
    const geo = new THREE.BoxGeometry(60, 15, 6); // 10x long
    const mat = new THREE.MeshBasicMaterial({ color: 0x2d3e14, transparent: true, opacity: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    
    mesh.position.copy(targetPos).setY(targetPos.y + 5);
    mesh.lookAt(pos.clone().add(dir));
    mesh.rotateY(Math.PI/2); // wall perpendicular
    scene.add(mesh);

    // Decorate with vine bits
    for (let i = 0; i < 25; i++) {
        const v = new THREE.Mesh(new THREE.TorusGeometry(6, 1.0, 8, 12), new THREE.MeshBasicMaterial({color: 0x1a240c}));
        v.position.set((Math.random()-0.5)*120, (Math.random()-0.5)*25, 0);
        v.rotation.set(Math.random(), Math.random(), Math.random());
        mesh.add(v);
    }

    activeSpells.push({
        mesh: mesh,
        ownerId: ownerId,
        spellName: "ENTANGLE",
        life: 7.0,
        type: "box",
        size: new THREE.Vector3(120, 25, 30), // 2x wider/longer
        update: function(dt) {
            this.life -= dt;
            if (this.life < 1.0) this.mesh.material.opacity = this.life;
            return this.life <= 0;
        }
    });
}

function castNaturesWrath(scene, pos, dir, ownerId) {
    // Pulse mesh
    const geo = new THREE.SphereGeometry(2, 32, 32);
    const mat = new THREE.MeshPhongMaterial({ 
        color: 0x00ff00, 
        emissive: 0x004400,
        transparent: true, 
        opacity: 0.9,
        flatShading: true
    });
    const mesh = new THREE.Mesh(geo, mat);
    
    mesh.position.copy(pos);
    scene.add(mesh);

    activeSpells.push({
        mesh: mesh,
        ownerId: ownerId,
        spellName: "NATURE'S WRATH",
        life: 1.8,
        type: "radius",
        radius: 120, // Massive nuke — set to max from the start
        update: function(dt) {
            this.life -= dt;
            this.mesh.scale.setScalar(this.mesh.scale.x + dt * 150); 
            this.mesh.material.opacity = this.life / 1.8;
            return this.life <= 0;
        }
    });
}

// ==========================================
// WIND WALKER SPELLS (2)
// ==========================================
function castGaleBlast(scene, pos, dir, ownerId) {
    // Visibility: Use 3D BoxGeometry so they actually render from all angles
    const slantedDir = dir.clone().add(new THREE.Vector3(0, 0.2, 0)).normalize();
    for (let i = 0; i < 30; i++) {
        const outDir = slantedDir.clone().add(new THREE.Vector3((Math.random()-0.5)*1.0, (Math.random()-0.5)*0.5, (Math.random()-0.5)*1.0)).normalize();
        const mesh = new THREE.Mesh(
            new THREE.BoxGeometry(5.0, 0.8, 0.8),
            new THREE.MeshBasicMaterial({ color: 0xccffff, transparent: true, opacity: 0.95 })
        );
        mesh.position.copy(pos).add(outDir.clone().multiplyScalar(4));
        mesh.lookAt(mesh.position.clone().add(outDir));
        scene.add(mesh);

        activeSpells.push({
            mesh: mesh,
            ownerId: ownerId,
            spellName: "GALE BLAST",
            life: 1.2,
            type: "radius",
            radius: 8,
            vel: outDir.multiplyScalar(150 + Math.random()*50),
            update: function(dt) {
                this.life -= dt;
                this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
                this.mesh.scale.setScalar(Math.max(0.1, this.life * 1.5));
                this.mesh.material.opacity = Math.max(0, this.life * 0.9);
                return this.life <= 0;
            }
        });
    }
}

function castTornado(scene, pos, dir, ownerId) {
    // 2x larger
    const geo = new THREE.CylinderGeometry(10, 2, 30, 16, 1, true);
    geo.translate(0, 15, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    
    mesh.position.copy(pos).add(dir.clone().multiplyScalar(10));
    mesh.position.y += 10; // Raise hitbox up so it covers the full tornado height
    scene.add(mesh);

    activeSpells.push({
        mesh: mesh,
        ownerId: ownerId,
        spellName: "TORNADO",
        life: 8.0,
        type: "special", // game.js handles pull physics
        physics: "tornado",
        radius: 15, // Visible hitbox for the whole tornado
        vel: dir.clone().multiplyScalar(25),
        update: function(dt) {
            this.life -= dt;
            this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
            this.mesh.rotation.y += dt * 20;
            // Pulsate size
            this.mesh.scale.set(1.0 + Math.sin(this.life*5)*0.1, 1.0, 1.0 + Math.sin(this.life*5)*0.1);
            return this.life <= 0;
        }
    });
}

function castWindShear(scene, pos, dir, ownerId) {
    // Slanted upwards
    const slantedDir = dir.clone().add(new THREE.Vector3(0, 0.1, 0)).normalize();
    // 3x projectiles
    for (let i = -10; i <= 10; i++) {
        const offsetAngle = i * 0.08;
        const shearDir = new THREE.Vector3(
            Math.cos(offsetAngle) * slantedDir.x - Math.sin(offsetAngle) * slantedDir.z,
            slantedDir.y,
            Math.sin(offsetAngle) * slantedDir.x + Math.cos(offsetAngle) * slantedDir.z
        ).normalize();
        
        const geo = new THREE.PlaneGeometry(36, 1.2); // 3x size
        const mat = new THREE.MeshBasicMaterial({ color: 0xccffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        
        mesh.position.copy(pos).add(shearDir.clone().multiplyScalar(4));
        mesh.lookAt(mesh.position.clone().add(shearDir));
        scene.add(mesh);

        activeSpells.push({
            mesh: mesh,
            ownerId: ownerId,
            spellName: "WIND SHEAR",
            life: 2.0,
            type: "radius",
            radius: 15, // 3x larger hitbox
            vel: shearDir.multiplyScalar(200),
            update: function(dt) {
                this.life -= dt;
                this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
                this.mesh.scale.set(1.0 + (1.8 - this.life)*3, 1.0, 1.0); 
                if (this.life < 0.5) this.mesh.material.opacity = this.life * 2;
                return this.life <= 0;
            }
        });
    }
}

// ==========================================
// WATER SHAPER SPELLS (3)
// ==========================================
function castWaterBall(scene, pos, dir, ownerId) {
    const geo = new THREE.SphereGeometry(2.0, 16, 16);
    const mat = new THREE.MeshPhongMaterial({ color: 0x00aaff, transparent: true, opacity: 0.8, shininess: 100 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos).add(dir.clone().multiplyScalar(5)).add(new THREE.Vector3(0, 1, 0));
    scene.add(mesh);

    activeSpells.push({
        mesh: mesh,
        ownerId: ownerId,
        spellName: "WATER BALL",
        life: 3.5,
        type: "radius",
        radius: 8, // 2x larger
        vel: dir.clone().add(new THREE.Vector3(0, 0.1, 0)).normalize().multiplyScalar(130),
        time: 0,
        update: function(dt) {
            this.life -= dt;
            this.time += dt;
            this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
            this.mesh.scale.set(1.0 + Math.sin(this.time*15)*0.2, 1.0 + Math.cos(this.time*15)*0.2, 1.0);
            return this.life <= 0;
        }
    });
}

function castFrostNova(scene, pos, dir, ownerId) {
    for (let i = 0; i < 40; i++) {
        const angle = (i / 40) * Math.PI * 2;
        const outDir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
        
        const geo = new THREE.ConeGeometry(1.2, 5, 4);
        geo.translate(0, 2.5, 0);
        const mat = new THREE.MeshPhongMaterial({ color: 0xbbffff, transparent: true, opacity: 0.9, emissive: 0x004444 });
        const mesh = new THREE.Mesh(geo, mat);
        
        mesh.position.copy(pos).add(outDir.clone().multiplyScalar(6));
        mesh.position.y -= 2; 
        
        mesh.lookAt(mesh.position.clone().add(outDir));
        mesh.rotateX(Math.PI/4);
        scene.add(mesh);

        activeSpells.push({
            mesh: mesh,
            ownerId: ownerId,
            spellName: "FROST NOVA",
            life: 2.0,
            type: "radius",
            radius: 5,
            vel: outDir.multiplyScalar(60),
            update: function(dt) {
                this.life -= dt;
                this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
                this.mesh.scale.setScalar(this.life * 1.5);
                return this.life <= 0;
            }
        });
    }
}

function castTsunami(scene, pos, dir, ownerId) {
    const groundY = pos.y - 2;
    // 300ft tall (100u), 400ft wide (120u)
    const geo = new THREE.BoxGeometry(400, 300, 20); 
    const mat = new THREE.MeshPhongMaterial({ color: 0x003366, transparent: true, opacity: 0.8, emissive: 0x001122 });
    const mesh = new THREE.Mesh(geo, mat);
    
    // Position on ground in front
    const flatDir = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    mesh.position.copy(pos).add(flatDir.clone().multiplyScalar(40));
    mesh.position.setY(groundY + 150);
    
    mesh.lookAt(mesh.position.clone().add(flatDir));
    scene.add(mesh);

    activeSpells.push({
        mesh: mesh,
        ownerId: ownerId,
        spellName: "TSUNAMI",
        life: 6.0,
        time: 0,
        type: "box",
        size: new THREE.Vector3(400, 300, 60), // Massive collision area
        vel: flatDir.clone().multiplyScalar(85),
        update: function(dt) {
            this.life -= dt;
            this.time += dt;
            this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
            this.mesh.scale.set(1.0, 1.0 + Math.sin(this.time*4)*0.1, 1.0);
            if (this.life < 1.0) this.mesh.material.opacity = this.life;
            return this.life <= 0;
        }
    });
}

// ==========================================
// ARCANE SCHOLAR SPELLS (4)
// ==========================================
function castArcaneMissiles(scene, pos, dir, ownerId) {
    for (let i = 0; i < 5; i++) { // 5 missiles
        setTimeout(() => {
            const geo = new THREE.IcosahedronGeometry(2.4, 1); // 2x size
            const mat = new THREE.MeshBasicMaterial({ color: 0xcc00ff, transparent: true, opacity: 0.9 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.copy(pos).add(dir.clone().multiplyScalar(5)).add(new THREE.Vector3((Math.random()-0.5)*8, (Math.random()-0.5)*8, (Math.random()-0.5)*8));
            scene.add(mesh);

            activeSpells.push({
                mesh: mesh,
                ownerId: ownerId,
                spellName: "ARCANE MISSILES",
                life: 4.5,
                type: "radius",
                radius: 8, // 2x larger
                vel: dir.clone().multiplyScalar(100),
                targetId: null,
                update: function(dt, players) {
                    this.life -= dt;
                    // Tracking Logic
                    if (!this.targetId) {
                        let minDist = 300;
                        for (let id in players) {
                            if (id === this.ownerId) continue;
                            const d = this.mesh.position.distanceTo(players[id].position);
                            if (d < minDist) { minDist = d; this.targetId = id; }
                        }
                    } else if (players[this.targetId]) {
                        const toTarget = players[this.targetId].position.clone().add(new THREE.Vector3(0, 3, 0)).sub(this.mesh.position).normalize();
                        this.vel.lerp(toTarget.multiplyScalar(120), dt * 6);
                    }
                    
                    this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
                    this.mesh.rotation.x += dt * 10;
                    return this.life <= 0;
                }
            });
        }, i * 200);
    }
}

function castManaRift(scene, pos, dir, ownerId) {
    // Mana Vortex Visual
    const group = new THREE.Group();
    group.position.copy(pos).add(dir.clone().multiplyScalar(15)).setY(pos.y + 0.1);
    scene.add(group);

    for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(8 + i*4, 0.4, 8, 32), new THREE.MeshBasicMaterial({ color: 0x8800ff, transparent: true, opacity: 0.6 }));
        ring.rotation.x = Math.PI/2;
        group.add(ring);
    }

    activeSpells.push({
        mesh: group,
        ownerId: ownerId,
        spellName: "MANA RIFT",
        life: 10.0,
        type: "radius",
        radius: 20,
        update: function(dt) {
            this.life -= dt;
            this.mesh.rotation.y += dt * 2;
            for (let child of this.mesh.children) {
                child.rotation.z += dt * 5;
                child.scale.setScalar(1 + Math.sin(this.life * 5) * 0.1);
            }
            if (this.life < 1.0) {
                for (let child of this.mesh.children) child.material.opacity = this.life * 0.6;
            }
            return this.life <= 0;
        }
    });
}

function castMagicBurst(scene, pos, dir, ownerId) {
    // 10x larger purple nuke
    const geo = new THREE.SphereGeometry(1, 32, 32);
    const mat = new THREE.MeshBasicMaterial({ color: 0xaa00ff, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos).add(dir.clone().multiplyScalar(10));
    scene.add(mesh);

    const light = new THREE.PointLight(0xaa00ff, 500, 150);
    mesh.add(light);

    activeSpells.push({
        mesh: mesh,
        ownerId: ownerId,
        spellName: "MAGIC BURST",
        life: 2.5,
        type: "radius",
        radius: 200, // Huge nuke hitbox from the start
        update: function(dt) {
            this.life -= dt;
            const size = (2.5 - this.life) * 100; // massive expand
            this.mesh.scale.setScalar(size);
            this.mesh.material.opacity = this.life / 2.5;
            return this.life <= 0;
        }
    });
}

// ==========================================
// FIRE MAGE SPELLS (5)
// ==========================================
function castFireball(scene, pos, dir, ownerId) {
    const geo = new THREE.SphereGeometry(1.8, 16, 16);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff4400, emissive: 0xff0000, emissiveIntensity: 2 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos).add(dir.clone().multiplyScalar(5));
    scene.add(mesh);
    
    const light = new THREE.PointLight(0xff4400, 200, 30);
    mesh.add(light);

    activeSpells.push({
        mesh: mesh,
        ownerId: ownerId,
        spellName: "FIREBALL",
        life: 4.0,
        type: "radius",
        radius: 6,
        vel: dir.clone().add(new THREE.Vector3(0, 0.15, 0)).normalize().multiplyScalar(160),
        update: function(dt) {
            this.life -= dt;
            this.mesh.position.add(this.vel.clone().multiplyScalar(dt));
            return this.life <= 0;
        }
    });
}

function castFlameBreath(scene, pos, dir, ownerId) {
    // 5x longer range (life * vel)
    const particles = [];
    for (let i = 0; i < 50; i++) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true }));
        mesh.position.copy(pos);
        scene.add(mesh);
        
        const spread = (Math.random()-0.5)*0.4;
        const pVel = dir.clone().add(new THREE.Vector3((Math.random()-0.5)*0.3, (Math.random()-0.5)*0.3, (Math.random()-0.5)*0.3)).normalize().multiplyScalar(90);
        particles.push({ mesh, vel: pVel, life: 2.5 }); // 5x range
    }

    activeSpells.push({
        parts: particles,
        ownerId: ownerId,
        spellName: "FLAME BREATH",
        type: "radius",
        radius: 30, // Absolute massive cone hitbox
        mesh: particles[0].mesh,
        update: function(dt) {
            let allDead = true;
            for (let p of this.parts) {
                if (p.life > 0) {
                    p.life -= dt;
                    p.mesh.position.add(p.vel.clone().multiplyScalar(dt));
                    p.mesh.scale.setScalar(p.life * 2);
                    p.mesh.material.opacity = p.life;
                    allDead = false;
                } else {
                    p.mesh.visible = false;
                }
            }
            return allDead;
        }
    });
}

function castFireSpears(scene, pos, dir, ownerId) {
    // Re-implemented as Flame Storm Cloud
    const cloudGeo = new THREE.SphereGeometry(15, 16, 8);
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0x441100, transparent: true, opacity: 0.8 });
    const cloud = new THREE.Mesh(cloudGeo, cloudMat);
    cloud.position.copy(pos).add(dir.clone().multiplyScalar(100)).setY(100); // 100u high
    scene.add(cloud);

    activeSpells.push({
        mesh: cloud,
        ownerId: ownerId,
        spellName: "FIRE SPEARS",
        life: 8.0,
        type: "special", // damage handled via rain
        update: function(dt, players) {
            this.life -= dt;
            // Rain down fire bolts
            if (Math.random() > 0.4) { // More frequent bolts
                const boltGeo = new THREE.CylinderGeometry(1.0, 1.0, 15, 4);
                const boltMat = new THREE.MeshBasicMaterial({ color: 0xff4400 });
                const bolt = new THREE.Mesh(boltGeo, boltMat);
                bolt.position.set(this.mesh.position.x + (Math.random()-0.5)*80, this.mesh.position.y, this.mesh.position.z + (Math.random()-0.5)*80); // 2x coverage
                bolt.rotation.x = Math.PI/2; // Point downwards
                scene.add(bolt);

                activeSpells.push({
                    mesh: bolt, 
                    ownerId: this.ownerId, 
                    spellName: "FIRE SPEARS_RAIN", 
                    life: 2.5, type: "radius", radius: 10, // Larger bolts
                    update: function(dt) {
                        this.life -= dt;
                        this.mesh.position.y -= dt * 180;
                        return this.life <= 0 || this.mesh.position.y < -10;
                    }
                });
            }
            if (this.life < 1.0) this.mesh.material.opacity = this.life;
            return this.life <= 0;
        }
    });
}
