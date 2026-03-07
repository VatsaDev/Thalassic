const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Serve static files from current directory
app.use(express.static(__dirname));

const players = {};

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // Create new player data
    players[socket.id] = {
        x: 0, y: 1, z: 0,
        color: '#' + Math.floor(Math.random()*16777215).toString(16),
        name: "Guest_" + Math.floor(Math.random() * 1000)
    };

    // Send current state to new player
    socket.emit('currentPlayers', players);

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

    // Handle Disconnect
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
