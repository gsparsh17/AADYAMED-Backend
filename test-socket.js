const io = require('socket.io-client');
const socket = io('http://13.48.49.45', { transports: ['websocket'] });

socket.on('connect', () => {
    console.log('Test Socket Connected. Joining room...');
    // We need a dummy session id that resembles a mongo id
    const dummySessionId = '6620ca123456789012345678';
    
    socket.emit('join_chat', { sessionId: dummySessionId });

    socket.on('receive_message', (data) => {
        console.log('RECEIVED MESSAGE:', JSON.stringify(data, null, 2));
        process.exit(0);
    });

    socket.on('error', (err) => {
        console.error('SOCKET ERROR:', err);
        process.exit(1);
    });

    setTimeout(() => {
        console.log('Sending test message...');
        socket.emit('send_message', {
            sessionId: dummySessionId,
            senderId: '6620ca123456789012345679',
            senderType: 'patient',
            content: 'Hello world from test script',
            messageType: 'text'
        });
    }, 1000);
});

setTimeout(() => {
    console.log('Test timeout.');
    process.exit(1);
}, 5000);
