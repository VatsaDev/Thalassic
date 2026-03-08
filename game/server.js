const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.json());

// Health check for API
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback items endpoint (in case router fails)
app.get('/api/marketplace/items', (req, res) => {
  try {
    const items = require(path.join(__dirname, '../config/items.json'));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API routes (must be before static so /api/* is handled)
const lootboxRouter = require(path.join(__dirname, '../api/routes/lootbox'));
const marketplaceRouter = require(path.join(__dirname, '../api/routes/marketplace'));
app.use('/api/lootbox', lootboxRouter);
app.use('/api/marketplace', marketplaceRouter);

// Serve static files from current directory
app.use(express.static(__dirname));

const players = {};
let matchEndTime = null;
let matchTimer = null;
let mapSeed = Math.random() * 10000;
const MATCH_DURATION = 5 * 60 * 1000; // 5 minutes

function startMatch() {
    matchEndTime = Date.now() + MATCH_DURATION;
    io.emit('matchInfo', { endTime: matchEndTime });

    matchTimer = setTimeout(() => {
        io.emit('matchEnded');
        matchEndTime = null;
        matchTimer = null;
    }, MATCH_DURATION);
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    // Send map seed immediately upon connection
    socket.emit('initGame', { seed: mapSeed });

    const username = socket.handshake.query.username || ("Guest_" + Math.floor(Math.random() * 1000));
    const skinId = parseInt(socket.handshake.query.skin || "0", 10);

    // Create new player data
    players[socket.id] = {
        x: 0, y: 1, z: 0,
        color: '#' + Math.floor(Math.random() * 16777215).toString(16),
        name: username,
        skinId: skinId,
        hp: 100,
        kills: 0,
        deaths: 0
    };

    // Send current state to new player
    socket.emit('currentPlayers', players);
    
    // Start match if first player joins and no match is active
    if (!matchEndTime) {
        startMatch();
    } else {
        socket.emit('matchInfo', { endTime: matchEndTime });
    }

    // Broadcast new player to others
    socket.broadcast.emit('newPlayer', {
        id: socket.id,
        player: players[socket.id]
    });

    // Handle Movement
    socket.on('playerMovement', (movementData) => {
        if (players[socket.id]) {
            players[socket.id].x = movementData.x;
            players[socket.id].y = movementData.y;
            players[socket.id].z = movementData.z;
            socket.broadcast.emit('playerMoved', {
                id: socket.id,
                x: movementData.x,
                y: movementData.y,
                z: movementData.z
            });
        }
    });

    // Handle Combat
    socket.on('castSpell', (spellData) => {
        // Broadcast to everyone else so they see the visuals
        socket.broadcast.emit('opponentSpell', {
            id: socket.id,
            ...spellData
        });
    });

    socket.on('playerHit', (hitData) => {
        const targetId = hitData.targetId;
        const damage = hitData.damage || 10;
        const attackerId = socket.id;
        
        if (players[targetId] && players[targetId].hp > 0) {
            players[targetId].hp = Math.max(0, players[targetId].hp - damage);
            
            // Broadcast updated HP to everyone
            io.emit('hpUpdate', {
                id: targetId,
                hp: players[targetId].hp
            });

            // If player dies
            if (players[targetId].hp <= 0) {
                // Update KD stats
                players[targetId].deaths = (players[targetId].deaths || 0) + 1;
                if (players[attackerId]) {
                    players[attackerId].kills = (players[attackerId].kills || 0) + 1;
                }

                // Broadcast death event with position for blood explosion
                io.emit('playerDied', {
                    id: targetId,
                    killerId: attackerId,
                    x: players[targetId].x,
                    y: players[targetId].y,
                    z: players[targetId].z
                });

                // Broadcast KD updates
                if (players[attackerId]) {
                    io.emit('kdUpdate', { id: attackerId, kills: players[attackerId].kills, deaths: players[attackerId].deaths });
                }
                io.emit('kdUpdate', { id: targetId, kills: players[targetId].kills || 0, deaths: players[targetId].deaths });

                // Respawn after 3 seconds
                setTimeout(() => {
                    if (players[targetId]) {
                        players[targetId].hp = 100;
                        players[targetId].x = 50;
                        players[targetId].y = 100;
                        players[targetId].z = -50;
                        io.emit('playerRespawn', { id: targetId, x: 50, y: 100, z: -50, hp: 100 });
                    }
                }, 3000);
            }
        }
    });

    socket.on('playerEffect', (data) => {
        // Broadcast effect to specific target or room
        if (data.targetId) {
            io.to(data.targetId).emit('applyEffect', data);
        }
    });

    // Handle Disconnect
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
        
        // If everyone leaves, clear the match so it restarts on next join
        if (Object.keys(players).length === 0) {
            clearTimeout(matchTimer);
            matchEndTime = null;
            matchTimer = null;
            mapSeed = Math.random() * 10000; // Generate a fresh map for next join
        }
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
